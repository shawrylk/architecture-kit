// A fragment the workflow checks share to find where a piece of work lives: the worktree a dispatch prompt
// names, the path spelling of Git Bash, and a read of one sha that tells a failed git from an unknown commit.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILE } from "../config.mjs";
import { pathKey } from "./git-read.mjs";
import { commonDirOf } from "./ledger.mjs";
import { workflowAt } from "./workflow-settings.mjs";

const WORKTREE_LINE = /^[ \t]*Worktree:[ \t]*(\S.*?)[ \t]*$/im;
const QUOTES = /^["'`]|["'`]$/g;
const GIT_TIMEOUT_MS = 10_000;
const TRANSCRIPT_HEAD_BYTES = 1024 * 1024;
const TRANSCRIPT_HEAD_LINES = 50;

const PAREN_TAIL = /\s+\(.*$/;
const QUOTED = /^(["'`])(.*?)\1/;

/** A Git Bash drive path, `/c/Users/x`, as Windows spells it, `c:/Users/x`. Every other spelling and platform is unchanged. */
export function nativePath(spelled, platform = process.platform) {
  return platform === "win32" ? spelled.replace(/^\/([A-Za-z])(?:\/|$)/, "$1:/") : spelled;
}

/**
 * The paths a `Worktree:` line might name, best first. A controller often adds a note after the path, as in
 * `Worktree: C:/x/wt (branch feat/1-y)`, so the first candidate ends at the first whitespace before a `(`.
 * The rest are the whole line, then each shorter prefix that ends at whitespace, for a path with a space.
 */
export function worktreeCandidates(prompt) {
  const line = WORKTREE_LINE.exec(prompt)?.[1];
  if (line === undefined) return [];
  const quoted = QUOTED.exec(line);
  if (quoted) return [quoted[2]];
  const whole = line.replace(QUOTES, "");
  const candidates = [whole.replace(PAREN_TAIL, ""), whole];
  for (const gap of [...whole.matchAll(/\s+/g)].reverse()) candidates.push(whole.slice(0, gap.index));
  return [...new Set(candidates.filter((candidate) => candidate !== ""))];
}

/** The worktree path a dispatch prompt names on its `Worktree:` line, or null. */
export const worktreeNamed = (prompt) => worktreeCandidates(prompt)[0] ?? null;

/**
 * Finds the worktree a prompt names: the first candidate that exists on disk, resolved against `base`.
 * @returns `{ spelled, abs, found }`, or null when the prompt has no `Worktree:` line. When no candidate
 * exists, `spelled` and `abs` are those of the first candidate and `found` is false.
 */
export function resolveNamedWorktree(prompt, base, exists = existsSync) {
  const candidates = worktreeCandidates(prompt);
  if (candidates.length === 0) return null;
  const absOf = (spelled) => path.resolve(base, nativePath(spelled));
  const hit = candidates.find((candidate) => exists(absOf(candidate)));
  const spelled = hit ?? candidates[0];
  return { spelled, abs: absOf(spelled), found: hit !== undefined };
}

/**
 * Reads one commit. `--verify --quiet` exits 1 for a ref it does not know, so only that exit is "unknown";
 * a spawn error, a signal, a timeout, and every other exit are a failed read.
 * @returns `{ sha }`, `{ unknown: true }`, or `{ error }`
 */
export function commitLookup(cwd, ref, { run = spawnSync, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const result = run("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
  });
  if (result.error) return { error: result.error.code === "ETIMEDOUT" ? `git timed out after ${timeoutMs} ms` : result.error.message };
  if (result.signal) return { error: `git ended on ${result.signal}` };
  if (result.status === 0) {
    const sha = (result.stdout ?? "").trim();
    return sha === "" ? { unknown: true } : { sha };
  }
  if (result.status === 1) return { unknown: true };
  return { error: (result.stderr ?? "").trim() || `git exited ${result.status}` };
}

/** The first line of a transcript that is a user message, as text, or null. Reads the head of the file only. */
export function firstUserText(file) {
  if (typeof file !== "string" || file === "") return null;
  let fd;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(TRANSCRIPT_HEAD_BYTES);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, read).toString("utf8").split(/\r?\n/).slice(0, TRANSCRIPT_HEAD_LINES);
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.type !== "user" && record?.message?.role !== "user") continue;
      const content = record.message?.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n");
      return null;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The `Worktree:` path in the first user message of an agent's own transcript, as written, or null. */
export const transcriptWorktree = (file) => {
  const text = firstUserText(file);
  return text === null ? null : worktreeNamed(text);
};

const commonDirIn = (root) => {
  try {
    return commonDirOf(root);
  } catch {
    // A `.git` file that cannot be read names no repository.
    return null;
  }
};

/**
 * The workflow of the repository that holds the checkout at `root`. The repository decides, never the
 * checkout, so a task that edits `qc.config.json` in its worktree cannot turn its own review off.
 * - A checkout that shares the git common dir of `cwdWorkflow` uses `cwdWorkflow`.
 * - Another repository uses the config of its primary checkout, and the checkout's own only when the
 *   primary checkout has none.
 * Throws when the config is wrong, as `workflowAt` does.
 */
export function workflowOfRepo(root, cwdWorkflow = null) {
  const common = commonDirIn(root);
  if (cwdWorkflow && common) {
    const shared = commonDirIn(cwdWorkflow.root);
    if (shared && pathKey(shared) === pathKey(common)) return cwdWorkflow;
  }
  const primary = common && path.basename(common) === ".git" ? path.dirname(common) : null;
  if (primary && existsSync(path.join(primary, CONFIG_FILE))) return workflowAt(primary);
  return workflowAt(root);
}
