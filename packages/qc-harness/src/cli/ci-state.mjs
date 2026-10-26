// The CI state of a commit, read from its GitHub check runs. The task gate uses this state before a review.

import { parseApiList, runGh } from "./gh-run.mjs";
import { originOf } from "./git-read.mjs";
import { checkRunsState } from "./check-verdict.mjs";

// The hook has a 10 second limit. The origin read and both gh calls fit within it, so a timeout leaves CI unknown.
const GH_TIMEOUT_MS = 3_000;
const ORIGIN_TIMEOUT_MS = 1_000;
const short = (sha) => sha.slice(0, 7);

/** The reason the newest check runs are not green, or null when they pass or are absent. */
export const notGreenReason = (runs) => checkRunsState(runs).reason;

/**
 * What CI says about `sha`: `reason` names a run that failed or still runs, as `CI on <short sha>: <why>`.
 * `pending: true` marks an unfinished check or workflow, or a missing required check, when completed checks pass.
 * `unknown` says why nothing is known: no sha, no `origin`, a gh that fails or times out, a reply that does not parse, or no check runs.
 * `gh` and `origin` replace the real reads, for a test.
 */
export function ciState(sha, cwd, { gh = runGh, origin = originOf, requiredChecks = [] } = {}) {
  const unknown = (why) => ({ reason: null, unknown: why });
  if (typeof sha !== "string" || sha === "") return unknown("there is no commit to ask about");
  const repo = origin(cwd, ORIGIN_TIMEOUT_MS);
  if (repo === null) return unknown("the checkout has no readable origin");
  const out = gh(["api", `repos/${repo}/commits/${sha}/check-runs?per_page=100&filter=all`, "--paginate", "--slurp"], { cwd, timeoutMs: GH_TIMEOUT_MS });
  if (out === null) return unknown("gh failed or timed out");
  const runs = parseApiList(out, "check_runs");
  if (runs === null) return unknown("gh answered with no readable check_runs list");
  let state = checkRunsState(runs, { requiredChecks });
  const workflows = gh(["api", `repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`, "--paginate", "--slurp"], { cwd, timeoutMs: GH_TIMEOUT_MS });
  const workflowRuns = parseApiList(workflows, "workflow_runs");
  if (workflowRuns === null && state.reason === null) return unknown("gh answered with no readable workflow_runs list");
  if (workflowRuns !== null) state = checkRunsState(runs, {
    workflowRuns: workflowRuns.filter((run) => run.head_sha === sha),
    requiredChecks,
  });
  if (runs.length === 0 && state.reason === null) return unknown(`${short(sha)} has no check runs`);
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
