import { strict as assert } from "node:assert";
import { test } from "node:test";
import { budgetRoleOf, roleBudgetVerdict } from "./role-budget.mjs";

const budget = { remindAt: 110_000, handoffAt: 150_000 };
const call = { tool_name: "Bash", tool_input: { command: "npm test" } };

test("budgetRoleOf resolves the configured roles only while dispatch is on", () => {
  for (const [agentType, role] of [
    ["architecture:sdd-implementer", "implementer"],
    ["architecture:sdd-reviewer", "reviewer"],
    ["sdd-branch-reviewer", "reviewer"],
    ["general-purpose", null],
  ]) {
    assert.equal(budgetRoleOf(agentType, { dispatch: {} }), role);
    assert.equal(budgetRoleOf(agentType, {}), null);
  }
  const swarm = { dispatch: { implementerTypes: ["builder"] }, review: { reviewerTypes: { task: ["checker"] } } };
  assert.equal(budgetRoleOf("builder", swarm), "implementer");
  assert.equal(budgetRoleOf("checker", swarm), "reviewer");
  assert.equal(budgetRoleOf("architecture:sdd-implementer", swarm), null);
});

test("the role budget reminds at the line once", () => {
  const state = {};
  const input = { role: "implementer", budget, call, state };
  assert.equal(roleBudgetVerdict({ ...input, tokens: 109_999 }), null);
  assert.deepEqual(state, {});
  const output = roleBudgetVerdict({ ...input, tokens: 110_000 });
  assert.match(output.hookSpecificOutput.additionalContext, /Context budget: .*finish the current item/i);
  assert.equal(state.budgetReminded, true);
  assert.equal(roleBudgetVerdict({ ...input, tokens: 120_000 }), null);
});

test("each role closes work calls at handoffAt and permits the hand-off", () => {
  for (const role of ["implementer", "reviewer"]) {
    const state = {};
    const input = { role, budget, call, state, tokens: 150_000 };
    const output = roleBudgetVerdict(input).hookSpecificOutput;
    assert.equal(output.permissionDecision, "deny");
    assert.match(output.permissionDecisionReason, role === "implementer" ? /HANDOFF: <note path>/ : /VERDICT:.*UNREVIEWED:/);
    assert.equal(state.budgetClosed, true);
    for (const handoff of [
      { tool_name: "Bash", tool_input: { command: "git push" } },
      { tool_name: "Read", tool_input: { file_path: "src/a.mjs" } },
      { tool_name: "SubagentHandback", tool_input: { message: "DONE" } },
    ]) assert.equal(roleBudgetVerdict({ ...input, call: handoff }), null);
    assert.equal(roleBudgetVerdict({ ...input, tokens: undefined }).hookSpecificOutput.permissionDecision, "deny");
  }
});

test("a disabled role budget or missing usage leaves the call alone", () => {
  assert.equal(roleBudgetVerdict({ role: "implementer", budget: null, call, state: {}, tokens: 160_000 }), null);
  assert.equal(roleBudgetVerdict({ role: "implementer", budget, call, state: {}, tokens: undefined }), null);
});
