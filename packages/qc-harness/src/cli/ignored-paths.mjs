// The resource for git's own view of which paths a checkout ignores. An ignored path never reaches
// a commit, so the edit guard and the Bash edit guard both let it through a protected branch.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const NUL = "\u0000";

/**
 * One `git check-ignore` call for every path. A tracked path is never ignored, as in `git status`.
 * @param {string} root the checkout's top level
 * @param {string[]} relPaths forward-slash, relative to `root`
 * @returns {Promise<Set<string>>} the ignored subset; empty when none is, or git cannot tell
 */
export async function ignoredPaths(root, relPaths) {
  if (relPaths.length === 0) return new Set();
  const pending = execFileAsync("git", ["check-ignore", "--stdin", "-z"], { cwd: root });
  // Git outside a checkout exits before it reads, and the broken pipe must not crash the hook.
  pending.child.stdin.on("error", () => {});
  pending.child.stdin.end(relPaths.join(NUL) + NUL);
  try {
    const { stdout } = await pending;
    return new Set(stdout.split(NUL).filter(Boolean));
  } catch {
    // Exit 1 means no path is ignored; any other failure keeps every path in scope of the guard.
    return new Set();
  }
}
