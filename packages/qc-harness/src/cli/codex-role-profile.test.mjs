import { test } from "node:test";
import assert from "node:assert/strict";
import { codexRoleProfile, scoutReportProblem } from "./codex-role-profile.mjs";

test("closed scout profile maps only its canonical runtime/budget to reviewer", () => {
  assert.deepEqual(codexRoleProfile("scout"), { runtime: "reviewer", route: "planner" });
  assert.ok(Object.isFrozen(codexRoleProfile("scout")));
  for (const claim of ["tests", "admin", {}, { role: "reviewer" }]) assert.throws(() => codexRoleProfile(claim));
  assert.equal(codexRoleProfile("planner").runtime, "reviewer");
});

test("scout handback keeps its own six labels without a verdict or RED/GREEN", () => {
  const text = "Gap: missing\nPlan:\n1. inspect\nCheck: tests\nRisks:\n- none\nQuestions: none\nBreaking: no\n";
  assert.equal(scoutReportProblem(text), null);
  assert.match(scoutReportProblem("VERDICT: APPROVED abcdef0"), /Gap/);
  assert.match(scoutReportProblem(text.replace("Breaking: no", "Breaking: maybe")), /Breaking/);
});
