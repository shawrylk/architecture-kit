// A fragment of the git reads the workflow checks share. Each read returns null or an empty list when git
// fails, so a check that cannot read the repository decides on what it has.

import { spawnSync } from "node:child_process";

export { keyOf as pathKey } from "./worktree.mjs";

/** @returns git's trimmed stdout, or null on a non-zero exit. */
export function gitOut(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? (result.stdout ?? "").trim() : null;
}

/** @returns the full sha that `ref` names as a commit, or null when the repository holds none. */
export const commitOf = (cwd, ref) => gitOut(cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);

/** @returns the branch checked out at `dir`, or null on a detached head. */
export const branchAt = (dir) => gitOut(dir, "branch", "--show-current") || null;

/** @returns the local branches whose head is `sha`, in ref order. */
export const branchesAt = (cwd, sha) =>
  (gitOut(cwd, "for-each-ref", "--points-at", sha, "--format=%(refname:short)", "refs/heads") ?? "").split(/\r?\n/).filter(Boolean);

/** @returns each linked worktree of the repository at `root`, with its branch and head; the primary checkout is left out. */
export function linkedWorktrees(root) {
  const out = gitOut(root, "worktree", "list", "--porcelain");
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
