// A fragment the workflow checks share to find where a piece of work lives: the worktree a dispatch prompt
// names, the path spelling of Git Bash, and a read of one sha that tells a failed git from an unknown commit.

import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { commonDirOf } from "./ledger.mjs";
import { workflowAt } from "./workflow-settings.mjs";

const WORKTREE_LINE = /^[ \t]*Worktree:[ \t]*(\S.*?)[ \t]*$/im;
const QUOTES = /^["'`]|["'`]$/g;
const GIT_TIMEOUT_MS = 10_000;
const TRANSCRIPT_HEAD_BYTES = 1024 * 1024;
const TRANSCRIPT_HEAD_LINES = 50;

/** The worktree path a dispatch prompt names on its `Worktree:` line, or null. */
export const worktreeNamed = (prompt) => WORKTREE_LINE.exec(prompt)?.[1]?.replace(QUOTES, "") ?? null;

/** A Git Bash drive path, `/c/Users/x`, as Windows spells it, `c:/Users/x`. Every other spelling and platform is unchanged. */
export function nativePath(spelled, platform = process.platform) {
  return platform === "win32" ? spelled.replace(/^\/([A-Za-z])(?:\/|$)/, "$1:/") : spelled;
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

/**
 * The workflow of the repository that holds the checkout at `root`: the config of that checkout, else the
 * config of the repository's primary checkout, since a branch cut before the config existed has none.
 * Throws when the config is wrong, as `workflowAt` does.
 */
export function workflowOfRepo(root) {
  const own = workflowAt(root);
  if (own) return own;
  let common = null;
  try {
    common = commonDirOf(root);
  } catch {
    // A `.git` file that cannot be read leaves the checkout with no workflow.
  }
  return common && path.basename(common) === ".git" ? workflowAt(path.dirname(common)) : null;
}
