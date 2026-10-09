// The CI state of a commit, read from its GitHub check runs. The task gate asks it before a review: a
// head whose CI is not green changes before it is reviewed, so the review waits.

import { runGh } from "./gh-run.mjs";
import { originOf } from "./git-read.mjs";

const FAILED = new Set(["failure", "cancelled", "timed_out", "action_required"]);
const short = (sha) => sha.slice(0, 7);

/**
 * @param runs the `check_runs` array of the GitHub API
 * @returns why the head is not green, naming the run, or null when every run completed without a failure
 * or when there are no runs, because a head with no CI is unknown.
 */
export function notGreenReason(runs) {
  const failed = runs.find((entry) => entry.status === "completed" && FAILED.has(entry.conclusion));
  if (failed) return `${failed.name} ended ${failed.conclusion}`;
  const open = runs.find((entry) => entry.status !== "completed");
  return open ? `${open.name} is ${open.status}` : null;
}

/**
 * @returns the reason CI on `sha` is not green, as `CI on <short sha>: <why>`, or null when it is green or
 * unknown: gh fails, times out, answers with no check runs, or the checkout has no `origin`.
 * `gh` and `origin` replace the real reads, for a test.
 */
export function ciNotGreen(sha, cwd, { gh = runGh, origin = originOf } = {}) {
  if (typeof sha !== "string" || sha === "") return null;
  const repo = origin(cwd);
  if (repo === null) return null;
  const out = gh(["api", `repos/${repo}/commits/${sha}/check-runs?per_page=100`], { cwd });
  if (out === null) return null;
  let runs;
  try {
    runs = JSON.parse(out)?.check_runs;
  } catch {
    return null;
  }
  if (!Array.isArray(runs)) return null;
  const why = notGreenReason(runs);
  return why === null ? null : `CI on ${short(sha)}: ${why}`;
}
