// A fragment of the git reads the workflow checks share. Each read returns null or an empty list when git
// fails, so a check that cannot read the repository decides on what it has.

import { spawnSync } from "node:child_process";

export { keyOf as pathKey } from "./worktree.mjs";

const GIT_TIMEOUT_MS = 10_000;
const ORIGIN_TIMEOUT_MS = 5_000;

/** @returns git's trimmed stdout, or null on a non-zero exit or after `timeoutMs`. */
export function gitOutWithin(timeoutMs, cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: timeoutMs });
  return result.status === 0 ? (result.stdout ?? "").trim() : null;
}

/**
 * Runs git and keeps its exit status, for a read where a non-zero exit is an answer.
 * @returns `{ status, stdout }`, or `{ error }` when git does not run or passes `timeoutMs`.
 */
export function gitStatusWithin(timeoutMs, cwd, ...args) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: timeoutMs, env });
  if (result.error) return { error: result.error.code === "ETIMEDOUT" ? `git timed out after ${timeoutMs} ms` : result.error.message };
  if (result.signal) return { error: `git ended on ${result.signal}` };
  return { status: result.status, stdout: (result.stdout ?? "").trim() };
}

/** @returns true when `ancestor` is in the history of `descendant`, false when it is not, null when git cannot say. */
export function isAncestor(cwd, ancestor, descendant, timeoutMs = GIT_TIMEOUT_MS) {
  const { status } = gitStatusWithin(timeoutMs, cwd, "merge-base", "--is-ancestor", ancestor, descendant);
  return status === 0 ? true : status === 1 ? false : null;
}

/** @returns the sha that `branch` names on `remote`, or null when the remote does not answer in `timeoutMs` or lacks the branch. */
export function remoteTip(cwd, remote, branch, timeoutMs = ORIGIN_TIMEOUT_MS) {
  const { status, stdout } = gitStatusWithin(timeoutMs, cwd, "ls-remote", remote, `refs/heads/${branch}`);
  if (status !== 0) return null;
  return /^([0-9a-f]{40,64})\s/i.exec(stdout.split(/\r?\n/)[0] ?? "")?.[1] ?? null;
}

/** @returns git's trimmed stdout, or null on a non-zero exit or a timeout. */
export const gitOut = (cwd, ...args) => gitOutWithin(GIT_TIMEOUT_MS, cwd, ...args);

/** `owner/repo` from a git remote URL in the https, ssh, or scp spelling, or from gh's `[HOST/]OWNER/REPO`; lower case. */
export function repoOfSpelling(spelled) {
  const parts = String(spelled).trim().replace(/\/+$/, "").replace(/\.git$/i, "").split(/[/:]/).filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/").toLowerCase() : null;
}

/** The repository of the checkout's `origin` remote, or null when git cannot say or `timeoutMs` passes. */
export const originOf = (root, timeoutMs = ORIGIN_TIMEOUT_MS) => {
  const url = gitOutWithin(timeoutMs, root, "remote", "get-url", "origin");
  return url === null ? null : repoOfSpelling(url);
};

/** @returns the full sha that `ref` names as a commit, or null when the repository holds none. */
export const commitOf = (cwd, ref) => gitOut(cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);

/** @returns the branch checked out at `dir`, or null on a detached head. */
export const branchAt = (dir) => gitOut(dir, "branch", "--show-current") || null;

/** @returns the local branches whose head is `sha`, in ref order. `read` replaces `gitOut`, for a time budget. */
export const branchesAt = (cwd, sha, read = gitOut) =>
  (read(cwd, "for-each-ref", "--points-at", sha, "--format=%(refname:short)", "refs/heads") ?? "").split(/\r?\n/).filter(Boolean);

/** @returns each linked worktree of the repository at `root`, with its branch and head; the primary checkout is left out. A read that fails or passes `timeoutMs` finds none. */
export function linkedWorktrees(root, timeoutMs = GIT_TIMEOUT_MS) {
  const out = gitOutWithin(timeoutMs, root, "worktree", "list", "--porcelain");
  if (out === null) return [];
  return out
    .split(/\r?\n[ \t]*\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const field = (name) => lines.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1) ?? null;
      return { path: field("worktree"), branch: field("branch")?.replace(/^refs\/heads\//, "") ?? null, head: field("HEAD") };
    })
    .filter((entry) => entry.path)
    .slice(1);
}
