// `qc lint`: ESLint on the lines a change adds. A problem on a line the change leaves alone belongs
// to the code before it, so it never blocks: an agent that is refused for it edits code its task
// never named. The hooks, the pre-commit hook and CI all call this one command.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gitOut, gitStatusWithin } from "./git-read.mjs";

const LINTABLE = /\.(?:[cm]?[jt]sx?)$/;
const DIFF_TIMEOUT_MS = 30_000;

/**
 * The new-side line numbers of each file in a `git diff -U0` text. A deleted file is absent.
 * @returns {Map<string, Set<number>>}
 */
export function parseDiff(text) {
  const changed = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4);
      current = target === "/dev/null" ? null : target.replace(/^b\//, "");
      if (current !== null && !changed.has(current)) changed.set(current, new Set());
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current !== null) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let n = start; n < start + count; n++) changed.get(current).add(n);
    }
  }
  return changed;
}

/** The ref a change is measured from: the merge base with `ref` when it resolves, else HEAD, else null for a repository with no commit. */
export function baseOf(root, ref) {
  if (ref) {
    const mergeBase = gitOut(root, "merge-base", "HEAD", ref);
    if (mergeBase) return mergeBase;
  }
  return gitOut(root, "rev-parse", "--verify", "--quiet", "HEAD");
}

/**
 * Each changed file and its changed lines. `all` marks a file that is new as a whole.
 * Staged reads the index against HEAD; otherwise the working tree against `base`, with untracked files.
 * @returns {Map<string, Set<number> | "all">}
 */
export function changedLines(root, { staged = false, base = null } = {}) {
  const args = ["diff", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=ACMR"];
  if (staged) args.push("--cached");
  // With no commit yet every file is new, so there is nothing to diff against.
  const head = gitOut(root, "rev-parse", "--verify", "--quiet", "HEAD");
  if (head === null) {
    const listed = gitOut(root, "ls-files", ...(staged ? [] : ["--others", "--cached", "--exclude-standard"])) ?? "";
    return new Map(listed.split(/\r?\n/).filter(Boolean).map((file) => [file, "all"]));
  }
  if (!staged) args.push(base ?? head);
  const diff = gitStatusWithin(DIFF_TIMEOUT_MS, root, ...args);
  if (diff.error || diff.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${diff.error ?? diff.stdout}`);
  const changed = parseDiff(diff.stdout);
  if (!staged) {
    for (const file of (gitOut(root, "ls-files", "--others", "--exclude-standard") ?? "").split(/\r?\n/).filter(Boolean)) changed.set(file, "all");
  }
  return changed;
}

/**
 * The problems of each ESLint result that sit on a changed line. A fatal message, such as a parse
 * error, has no line of its own and always counts.
 * @returns {{ kept: Array<{ file: string, message: object }>, skipped: number }}
 */
export function onChangedLines(results, changed, root) {
  const kept = [];
  let skipped = 0;
  for (const result of results) {
    const file = path.relative(root, result.filePath).split(path.sep).join("/");
    const lines = changed.get(file);
    for (const message of result.messages) {
      if (message.fatal || lines === "all" || lines?.has(message.line)) kept.push({ file, message });
      else skipped++;
    }
  }
  return { kept, skipped };
}

/** The file as the index holds it, untrimmed so its line numbers stay, or null when git cannot read it. */
function stagedText(root, file) {
  const result = spawnSync("git", ["show", `:${file}`], { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 1 << 26 });
  return result.status === 0 ? result.stdout : null;
}

async function loadEslint(root) {
  let resolved;
  try {
    resolved = createRequire(path.join(root, "package.json")).resolve("eslint");
  } catch {
    return null;
  }
  return (await import(pathToFileURL(resolved).href)).ESLint;
}

function parseArgs(args) {
  const options = { staged: false, base: undefined, files: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--staged") options.staged = true;
    else if (args[i] === "--base") options.base = args[++i];
    else options.files.push(args[i]);
  }
  return options;
}

/** @returns the exit code: 1 when an error sits on a changed line, else 0. Warnings print and pass. */
export async function runLintChanged(config, args) {
  const root = config.root;
  const options = parseArgs(args);
  const ESLint = await loadEslint(root);
  if (ESLint === null) {
    console.log("lint skipped: eslint is not installed in this repository");
    return 0;
  }
  const base = options.staged ? null : baseOf(root, options.base ?? config.check.base);
  const changed = changedLines(root, { staged: options.staged, base });
  const wanted = options.files.map((file) => path.relative(root, path.resolve(file)).split(path.sep).join("/"));
  const eslint = new ESLint({ cwd: root });
  const files = [];
  for (const file of changed.keys()) {
    if (!LINTABLE.test(file) || (wanted.length > 0 && !wanted.includes(file))) continue;
    if (!existsSync(path.join(root, file)) || (await eslint.isPathIgnored(path.join(root, file)))) continue;
    files.push(file);
  }
  if (files.length === 0) return 0;

  const results = [];
  for (const file of files) {
    const filePath = path.join(root, file);
    // A staged commit is judged as it will be stored, not as the working tree holds it now.
    const staged = options.staged ? stagedText(root, file) : null;
    results.push(...(staged === null ? await eslint.lintFiles([filePath]) : await eslint.lintText(staged, { filePath })));
  }
  const { kept, skipped } = onChangedLines(results, changed, root);
  const errors = kept.filter(({ message }) => message.fatal || message.severity === 2);
  for (const { file, message } of kept) {
    const kind = message.fatal || message.severity === 2 ? "error" : "warning";
    console.error(`${file}:${message.line ?? 0}:${message.column ?? 0}  ${kind}  ${message.message}  ${message.ruleId ?? ""}`.trimEnd());
  }
  if (kept.length > 0) {
    console.error(`\n${errors.length} error(s) and ${kept.length - errors.length} warning(s) on the changed lines.`);
  }
  // Said once, so a reader knows the gate saw them and chose not to count them.
  if (skipped > 0) console.error(`${skipped} older problem(s) on lines this change leaves alone are not counted. Leave them alone.`);
  return errors.length > 0 ? 1 : 0;
}
