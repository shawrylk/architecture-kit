#!/usr/bin/env node
// The PreToolUse trigger that refuses a Bash or PowerShell command which skips the git hooks, or
// which runs a hook script by hand. It reads the command through the shell parsers and never runs it.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE } from "../config.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { powershellSegments } from "./powershell-command.mjs";
import { commandWords, gitCall, segmentsOf } from "./shell-command.mjs";

const HOOK_SCRIPTS = [
  "work-order-guard.mjs", "budget-guard.mjs", "bash-edit-guard.mjs", "worktree-isolation.mjs", "pre-edit-guard.sh",
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
const PARSERS = { Bash: segmentsOf, PowerShell: powershellSegments };
/** The shells whose `-c` or `-Command` argument is a command line of its own, and the parser that reads it. */
const NESTED = { bash: segmentsOf, sh: segmentsOf, pwsh: powershellSegments, powershell: powershellSegments };

const programName = (word) => path.basename(word ?? "").toLowerCase().replace(/\.exe$/, "");
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

/** @returns the command line a shell runs from `-c` or `-Command`, with its parser, or null. */
function nestedCommand(segment) {
  const [program, ...args] = commandWords(segment);
  const parse = NESTED[programName(program)];
  const at = args.findIndex((arg) => /^-(c|command)$/i.test(arg));
  return parse && at !== -1 && args[at + 1] !== undefined ? { command: args[at + 1], parse } : null;
}

const REASONS = {
  hooks:
    "the command skips the git hooks. The pre-commit and pre-push hooks are the gates: run the command " +
    "without `--no-verify` or `-n`, and fix what the hook names.",
  hooksPath:
    "`-c core.hooksPath=` points git away from the installed hooks, so the gates never run. Remove it.",
  script:
    "a hand run of a hook script writes a lease under a made-up session id, and that lease blocks later " +
    "edits in the worktree for hours. Test a hook only through its own suite (`node --test`), in temporary folders.",
};

/** @returns the reasons the command breaks a rule, in a stable order. */
export function violations(command, parse = segmentsOf) {
  const segments = parse(command);
  const found = new Set();
  for (const segment of segments) {
    const git = gitCall(segment);
    if (git && skipsHooks(git)) found.add("hooks");
    if (git && setsHooksPath(git)) found.add("hooksPath");
    const nested = nestedCommand(segment);
    if (nested) for (const key of violations(nested.command, nested.parse)) found.add(key);
  }
  if (!segments.some(runsTests) && segments.some(runsHookScript)) found.add("script");
  return Object.keys(REASONS).filter((key) => found.has(key));
}

/** The verdict on one Bash or PowerShell call. @returns the hook output, or null to let the call run with no message. */
export function decide(call) {
  const command = call.tool_input?.command;
  const parse = PARSERS[call.tool_name];
  if (!parse || typeof command !== "string") return null;
  const root = checkoutRootOf(call.cwd ?? process.cwd());
  if (!root || !existsSync(path.join(root, CONFIG_FILE))) return null;
  const found = violations(command, parse);
  if (found.length === 0) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `${call.tool_name} command guard: ${found.map((key) => REASONS[key]).join(" Also, ")}`,
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
