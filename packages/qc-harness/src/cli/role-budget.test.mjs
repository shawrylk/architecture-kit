import { strict as assert } from "node:assert";
import { test } from "node:test";
import { budgetRoleOf, orchestratorVerdict, roleBudgetVerdict } from "./role-budget.mjs";

const budget = { remindAt: 110_000, handoffAt: 150_000 };
const call = { tool_name: "Bash", tool_input: { command: "npm test" } };

test("the orchestrator stays quiet below compactAt and between checking calls", () => {
  const state = {};
  const input = { compactAt: 200_000, state };
  assert.equal(orchestratorVerdict({ ...input, tokens: 199_999, count: 5 }), null);
  assert.equal(orchestratorVerdict({ ...input, tokens: 213_000, count: 4 }), null);
  assert.deepEqual(state, {});
});

test("the orchestrator reminds at compactAt and repeats after twenty calls", () => {
  const state = {};
  const input = { tokens: 213_000, compactAt: 200_000, state };
  const note = orchestratorVerdict({ ...input, count: 5 });
  assert.match(note, /Context budget: this session sends about 213K tokens per call, past budgets\.orchestrator\.compactAt \(200000\)\. Run \/compact/);
  assert.match(note, /Keep the plan path, the open PR numbers, each branch and its head, and the ledger path in the summary\.$/);
  assert.equal(state.budgetFiredAt, 5);
  assert.equal(orchestratorVerdict({ ...input, count: 10 }), null);
  assert.equal(state.budgetFiredAt, 5);
  assert.equal(orchestratorVerdict({ ...input, count: 25 }), note);
  assert.equal(state.budgetFiredAt, 25);
});

test("the orchestrator reminds exactly at compactAt", () => {
  assert.match(orchestratorVerdict({ tokens: 200_000, compactAt: 200_000, count: 5, state: {} }), /about 200K tokens per call/);
});

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
