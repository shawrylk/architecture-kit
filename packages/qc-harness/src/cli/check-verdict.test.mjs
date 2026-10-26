import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkVerdict } from "./check-verdict.mjs";

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
