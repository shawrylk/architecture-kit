#!/usr/bin/env node
// The PreToolUse trigger that refuses a Bash or PowerShell command which skips the git hooks, runs a hook script
// by hand, or adds a worktree outside the worktree folder (QC-015). It reads the command and never runs it.

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE } from "../config.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { locationTarget, powershellSegments } from "./powershell-command.mjs";
import { cdTarget, commandWords, gitCall, segmentsOf } from "./shell-command.mjs";
import { nativePath } from "./workflow-place.mjs";
import { keyOf } from "./worktree.mjs";
import { worktreeRuleAt } from "./worktree-settings.mjs";

const HOOK_SCRIPTS = [
  "work-order-guard.mjs", "budget-guard.mjs", "bash-edit-guard.mjs", "worktree-isolation.mjs", "pre-edit-guard.sh",
  "report-stop.mjs", "plan-stop.mjs", "merge-guard.mjs", "issue-gate.mjs", "controller-guard.mjs", "worktree-gate.mjs",
];
const NO_VERIFY = "--no-verify";
// The shortest prefix git could still expand to `--no-verify`.
const NO_VERIFY_MIN = "--no-ver".length;
/** The long options of commit and push whose value is the next word, so that word is no flag. */
const VALUE_OPTIONS = new Set([
  "--message", "--file", "--author", "--date", "--template", "--reuse-message", "--reedit-message",
  "--fixup", "--squash", "--trailer", "--cleanup", "--pathspec-from-file", "--push-option", "--repo",
  "--receive-pack", "--exec",
]);
/** The short options of commit whose value is the rest of the cluster, or the next word. */
const COMMIT_VALUE_FLAGS = new Set(["m", "F", "C", "c", "t"]);

/** The parser for each guarded tool. */
export const PARSERS = { Bash: segmentsOf, PowerShell: powershellSegments };
/** The directory a segment moves to, read the way each parser's shell reads it. */
const MOVES = new Map([[segmentsOf, cdTarget], [powershellSegments, locationTarget]]);
/** The options of `git worktree add` whose value is the next word. */
const WORKTREE_VALUE_OPTIONS = new Set(["-b", "-B", "--reason"]);
/** A POSIX shell reads a command line from `-c`, alone or in a cluster of short flags: `-lc`, `-ic`, `-lic`, `-cl`. */
const POSIX_COMMAND_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;
const POWERSHELL_COMMAND_FLAG = /^-(c|command)$/i;
/** The shells whose `-c` or `-Command` argument is a command line of its own, the flag that names it, and the parser that reads it. */
const NESTED = Object.fromEntries([
  ...["bash", "sh", "zsh", "dash", "ksh"].map((name) => [name, { flag: POSIX_COMMAND_FLAG, parse: segmentsOf }]),
  ...["pwsh", "powershell"].map((name) => [name, { flag: POWERSHELL_COMMAND_FLAG, parse: powershellSegments }]),
]);

export const programName = (word) => path.basename(word ?? "").toLowerCase().replace(/\.exe$/, "");
const isNoVerify = (arg) => arg.length >= NO_VERIFY_MIN && NO_VERIFY.startsWith(arg);

/** True when a commit or push names `--no-verify`, or a commit names `-n` alone or in a flag cluster. */
function skipsHooks({ sub, args }) {
  if (sub !== "commit" && sub !== "push") return false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return false;
    if (isNoVerify(arg)) return true;
    if (VALUE_OPTIONS.has(arg)) i++;
    if (sub !== "commit" || !/^-[A-Za-z]/.test(arg)) continue;
    for (let at = 1; at < arg.length; at++) {
      if (arg[at] === "n") return true;
      // `-u` and `-S` take an optional value in the same cluster, as in `-uno`.
      if (arg[at] === "u" || arg[at] === "S") break;
      if (COMMIT_VALUE_FLAGS.has(arg[at])) {
        if (at === arg.length - 1) i++;
        break;
      }
    }
  }
  return false;
}

const setsHooksPath = ({ configs }) => configs.some((setting) => /^core\.hookspath=/i.test(setting ?? ""));

const namesHookScript = (word) => HOOK_SCRIPTS.some((name) => word.toLowerCase().endsWith(name));

/** True when the segment runs a hook script: through node, through a shell, or as the program itself. */
function runsHookScript(segment) {
  const [program, ...args] = commandWords(segment);
  if (program === undefined) return false;
  if (namesHookScript(program)) return true;
  const name = programName(program);
  return ["node", "bash", "sh"].includes(name) && args.some((arg) => !arg.startsWith("-") && namesHookScript(arg));
}

/** True when the segment runs a test runner, which may load a hook script on purpose. */
function runsTests(segment) {
  const [program, ...args] = commandWords(segment);
  if (programName(program) === "node" && args.includes("--test")) return true;
  return [program, ...args].some((word) => programName(word) === "vitest");
}

/**
 * @returns the command line a shell runs from `-c` or `-Command`, or that `eval` runs from its words joined with spaces,
 *   with its parser, or null.
 */
export function nestedCommand(segment) {
  const [program, ...args] = commandWords(segment);
  const name = programName(program);
  if (name === "eval") return args.length > 0 ? { command: args.join(" "), parse: segmentsOf } : null;
  const shell = Object.hasOwn(NESTED, name) ? NESTED[name] : null;
  const at = shell ? args.findIndex((arg) => shell.flag.test(arg)) : -1;
  if (at === -1) return null;
  // A POSIX shell takes the first word after its flags as the command line, so `-c -- 'cmd'` and `-c +x 'cmd'` still find it.
  const command = shell.parse === segmentsOf ? args.slice(at + 1).find((arg) => !/^[-+]/.test(arg)) : args[at + 1];
  return command === undefined ? null : { command, parse: shell.parse };
}

/** @returns the path that `git worktree add` names after its options, or null for another worktree command. */
function worktreeAddPath(args) {
  if (args[0] !== "add") return null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--") return args[i + 1] ?? null;
    if (WORKTREE_VALUE_OPTIONS.has(args[i])) i++;
    else if (!args[i].startsWith("-")) return args[i];
  }
  return null;
}

/** A path as the shell spells it, in the form of this platform. PowerShell also reads a backslash as a separator on Linux and macOS. */
function spelledPath(spelled, parse) {
  const word = parse === powershellSegments ? spelled.replace(/\\/g, "/") : spelled;
  return nativePath(word.replace(/^~(?=$|[\\/])/, os.homedir()));
}

/** A path as a shell resolves it from `cwd`. */
const resolveFrom = (cwd, spelled, parse) => path.resolve(cwd, spelledPath(spelled, parse));

/** True when `target` is one folder directly under `folder`, as `qc worktree add` makes it. */
function inFolder(folder, target) {
  const parts = path.relative(keyOf(folder), keyOf(target)).split(path.sep);
  return parts.length === 1 && parts[0] !== "" && parts[0] !== ".." && !path.isAbsolute(parts[0]);
}

const REASONS = {
  hooks:
    "the command skips the git hooks. The pre-commit and pre-push hooks are the gates: run the command " +
    "without `--no-verify` or `-n`, and fix what the hook names.",
  hooksPath:
    "`-c core.hooksPath=` points git away from the installed hooks, so the gates never run. Remove it.",
  script:
    "a hand run of a hook script writes a lease or a ledger record under a made-up session id, and that lease blocks later " +
    "edits in the worktree for hours. Test a hook only through its own suite (`node --test`), in temporary folders.",
  worktree:
    "a worktree lives in the worktree folder of the main checkout, so git ignores it and `qc worktree remove` finds it. " +
    "Run `npx qc worktree add <name> <branch>` from the repository, or give `git worktree add` a path one level under that folder.",
};

/**
 * The worktree folder that judges `git worktree add`: the one of the repository the command targets. A `cd`,
 * `Set-Location`, `-C`, or `--git-dir` into a repository names it, and else the session's own
 * repository does. The path that `add` names never decides, because git adds the worktree to the repository
 * of the working directory wherever the path is. `null` means the targeted repository is not guarded.
 */
function folderFor(place, from) {
  // `undefined` means no checkout holds `from`, and `null` means one does that is not guarded.
  const worked = place.folderAt(from);
  return worked === undefined ? place.folder : worked;
}

/**
 * @param {{cwd: string, folder: string, folderAt: (dir: string) => string | null | undefined} | null} [place] the working directory,
 *   the session's worktree folder, and the folder of the repository that holds a directory (`undefined` when none does, `null` when
 *   it is not guarded); null skips the worktree rule
 * @param {string[]} [refused] receives the folder of each refused worktree path
 * @returns the reasons the command breaks a rule, in a stable order.
 */
export function violations(command, parse = segmentsOf, place = null, refused = []) {
  const segments = parse(command);
  const found = new Set();
  let cwd = place?.cwd;
  for (const segment of segments) {
    const moved = place ? MOVES.get(parse)?.(segment) : null;
    if (moved != null) cwd = resolveFrom(cwd, moved, parse);
    const git = gitCall(segment);
    if (git && skipsHooks(git)) found.add("hooks");
    if (git && setsHooksPath(git)) found.add("hooksPath");
    const added = place && git?.sub === "worktree" ? worktreeAddPath(git.args) : null;
    if (added !== null) {
      const move = (dirs) => dirs.filter(Boolean).reduce((dir, next) => resolveFrom(dir, next, parse), cwd);
      const from = move(git.dirs);
      const repo = git.gitDir ? resolveFrom(move(git.dirs.slice(0, git.gitDir.after)), git.gitDir.dir, parse) : from;
      const folder = folderFor(place, repo);
      if (folder !== null && !inFolder(folder, resolveFrom(from, added, parse))) {
        found.add("worktree");
        refused.push(folder);
      }
    }
    const nested = nestedCommand(segment);
    if (nested) for (const key of violations(nested.command, nested.parse, place && { ...place, cwd }, refused)) found.add(key);
  }
  if (!segments.some(runsTests) && segments.some(runsHookScript)) found.add("script");
  return Object.keys(REASONS).filter((key) => found.has(key));
}

/** The worktree folder of the repository that holds `dir`: undefined when none does, null when it has no config or turns the rule off. */
function folderAt(dir) {
  return checkoutRootOf(dir) === null ? undefined : (worktreeRuleAt(dir)?.folder ?? null);
}

/** The verdict on one Bash or PowerShell call. @returns the hook output, or null to let the call run with no message. */
export function decide(call) {
  const command = call.tool_input?.command;
  const parse = PARSERS[call.tool_name];
  if (!parse || typeof command !== "string") return null;
  const cwd = call.cwd ?? process.cwd();
  const root = checkoutRootOf(cwd);
  if (!root || !existsSync(path.join(root, CONFIG_FILE))) return null;
  // The config is read only for a command that can add a worktree, so every other call stays cheap.
  const rule = /\bworktree\b/i.test(command) ? worktreeRuleAt(cwd) : null;
  const refused = [];
  const place = rule && { cwd: path.resolve(cwd), folder: rule.folder, folderAt };
  const found = violations(command, parse, place, refused);
  if (found.length === 0) return null;
  const reasonOf = (key) => (key === "worktree" ? `${REASONS.worktree} The folder is ${[...new Set(refused)].join(" or ")}.` : REASONS[key]);
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `${call.tool_name} command guard: ${found.map(reasonOf).join(" Also, ")}`,
    },
  };
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const isEntryPoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntryPoint) {
  let call = null;
  try {
    call = JSON.parse(await readStdin());
  } catch {
    // Not hook input, so there is no command to judge.
  }
  const output = call ? decide(call) : null;
  if (output) process.stdout.write(JSON.stringify(output));
}
