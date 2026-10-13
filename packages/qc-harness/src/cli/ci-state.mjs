// The branch that classifies a commit's GitHub check runs for the task gate's review policy.

import { runGh } from "./gh-run.mjs";
import { originOf } from "./git-read.mjs";

// The hook that asks has a 10 second limit, and a hook that the limit kills lets the call through. The two reads
// together stay well under it, so a slow gh leaves the head unknown and the review refusal stands.
const GH_TIMEOUT_MS = 3_000;
const ORIGIN_TIMEOUT_MS = 1_000;
const FAILED = new Set(["failure", "cancelled", "timed_out", "action_required"]);
const short = (sha) => sha.slice(0, 7);

function runState(runs) {
  const failed = runs.find((entry) => entry.status === "completed" && FAILED.has(entry.conclusion));
  if (failed) return { status: "red", reason: `${failed.name} ended ${failed.conclusion}` };
  const open = runs.find((entry) => entry.status !== "completed");
  return open ? { status: "open", reason: `${open.name} is ${open.status}` } : { status: "green", reason: null };
}

/**
 * @param runs the `check_runs` array of the GitHub API
 * @returns why the head is not green, naming the run, or null when every run completed without a failure
 * or when there are no runs, because a head with no CI is unknown.
 */
export const notGreenReason = (runs) => runState(runs).reason;

/**
 * `status` is red, open, green, or unknown. `reason` names a failed or open run as `CI on <short sha>: <why>`.
 * `unknown` says why nothing is known: no sha, no `origin`, a gh that fails or times out, a reply that does not parse, or no check runs.
 * `gh` and `origin` replace the real reads, for a test.
 */
export function ciState(sha, cwd, { gh = runGh, origin = originOf } = {}) {
  const unknown = (why) => ({ status: "unknown", reason: null, unknown: why });
  if (typeof sha !== "string" || sha === "") return unknown("there is no commit to ask about");
  const repo = origin(cwd, ORIGIN_TIMEOUT_MS);
  if (repo === null) return unknown("the checkout has no readable origin");
  const out = gh(["api", `repos/${repo}/commits/${sha}/check-runs?per_page=100`], { cwd, timeoutMs: GH_TIMEOUT_MS });
  if (out === null) return unknown("gh failed or timed out");
  let runs;
  try {
    runs = JSON.parse(out)?.check_runs;
  } catch {
    return unknown("gh answered with text that is not JSON");
  }
  if (!Array.isArray(runs)) return unknown("gh answered with no check_runs list");
  if (runs.length === 0) return unknown(`${short(sha)} has no check runs`);
  const { status, reason } = runState(runs);
  return { status, reason: reason === null ? null : `CI on ${short(sha)}: ${reason}`, unknown: null };
}

/**
 * @returns the reason CI on `sha` is not green, as `CI on <short sha>: <why>`, or null when it is green or
 * unknown. `ciState` tells those two apart.
 */
export const ciNotGreen = (sha, cwd, deps) => ciState(sha, cwd, deps).reason;
