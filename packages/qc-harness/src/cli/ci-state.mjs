// The CI state of a commit, read from its GitHub check runs. The task gate uses this state before a review.

import { runGh } from "./gh-run.mjs";
import { originOf } from "./git-read.mjs";

// The hook that asks has a 10 second limit, and a hook that the limit kills lets the call through. The two reads
// together stay well under it, so a slow gh leaves the head unknown and the review refusal stands.
const GH_TIMEOUT_MS = 3_000;
const ORIGIN_TIMEOUT_MS = 1_000;
const FAILED = new Set(["failure", "cancelled", "timed_out", "action_required"]);
const short = (sha) => sha.slice(0, 7);

/** The branch that selects a failure before an unfinished check, using the newest run of each check. */
function checkRunsState(runs) {
  const newestByName = new Map();
  for (const entry of runs) {
    const current = newestByName.get(entry.name);
    if (!current || entry.started_at > current.started_at || (entry.started_at === current.started_at && entry.id > current.id)) {
      newestByName.set(entry.name, entry);
    }
  }
  const newest = [...newestByName.values()];
  const failed = newest.find((entry) => entry.status === "completed" && FAILED.has(entry.conclusion));
  if (failed) return { reason: `${failed.name} ended ${failed.conclusion}`, pending: false };
  const open = newest.find((entry) => entry.status !== "completed");
  return { reason: open ? `${open.name} is ${open.status}` : null, pending: Boolean(open) };
}

/** The reason the newest check runs are not green, or null when they pass or are absent. */
export const notGreenReason = (runs) => checkRunsState(runs).reason;

/**
 * What CI says about `sha`: `reason` names a run that failed or still runs, as `CI on <short sha>: <why>`.
 * `pending: true` marks an unfinished check when every completed check passes.
 * `unknown` says why nothing is known: no sha, no `origin`, a gh that fails or times out, a reply that does not parse, or no check runs.
 * `gh` and `origin` replace the real reads, for a test.
 */
export function ciState(sha, cwd, { gh = runGh, origin = originOf } = {}) {
  const unknown = (why) => ({ reason: null, unknown: why });
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
  const state = checkRunsState(runs);
  return {
    reason: state.reason === null ? null : `CI on ${short(sha)}: ${state.reason}`,
    unknown: null,
    ...(state.pending ? { pending: true } : {}),
  };
}

/**
 * @returns the reason CI on `sha` is not green, as `CI on <short sha>: <why>`, or null when it is green or
 * unknown. `ciState` tells those two apart.
 */
export const ciNotGreen = (sha, cwd, deps) => ciState(sha, cwd, deps).reason;
