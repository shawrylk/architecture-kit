import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkVerdict, checkRunsState } from "./check-verdict.mjs";

test("workflow and name identify checks across suites without merging different workflows", () => {
  const older = { name: "build", status: "completed", conclusion: "cancelled", check_suite: { id: 1 }, id: 1 };
  const newer = { ...older, conclusion: "success", check_suite: { id: 2 }, id: 2 };
  for (const runs of [[older, newer], [newer, older]]) {
    const workflowRuns = [{ check_suite_id: 1, path: "ci.yml", status: "completed" }, { check_suite_id: 2, path: "ci.yml", status: "completed" }];
    assert.deepEqual(checkRunsState(runs, { workflowRuns }), { reason: null, pending: false });
    assert.equal(checkRunsState(runs, { workflowRuns: [workflowRuns[0], { ...workflowRuns[1], path: "other.yml" }] }).reason, "build ended cancelled");
    assert.equal(checkRunsState(runs, { workflowRuns: [workflowRuns[1]] }).reason, "build ended cancelled");
  }
});

test("only success, neutral, and skipped pass a completed check", () => {
  for (const conclusion of ["success", "neutral", "skipped", "failure", "cancelled", "timed_out", "action_required", "stale", "startup_failure", "future", "", null, undefined]) {
    const expected = ["success", "neutral", "skipped"].includes(conclusion) ? "passed" : "failed";
    assert.equal(checkVerdict({ status: "completed", conclusion }), expected);
    assert.equal(checkVerdict({ status: "COMPLETED", conclusion: conclusion?.toUpperCase() }), expected);
  }
});

test("unfinished checks and status contexts remain pending", () => {
  for (const status of ["in_progress", "waiting", "pending", "requested", "future"]) {
    assert.equal(checkVerdict({ status, conclusion: "success" }), "pending");
  }
  assert.equal(checkVerdict({ status: "QUEUED" }), "queued");
  for (const state of ["PENDING", "EXPECTED"]) {
    assert.equal(checkVerdict({ __typename: "StatusContext", state }), "pending");
  }
});
