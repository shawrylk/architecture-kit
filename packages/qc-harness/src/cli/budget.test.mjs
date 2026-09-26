import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DEFAULT_BUDGET, budgetOf, budgetVerdict, isHandoffCall } from "./budget.mjs";

const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
const write = (file_path) => ({ tool_name: "Write", tool_input: { file_path, content: "x" } });
const edit = (file_path) => ({ tool_name: "Edit", tool_input: { file_path, old_string: "a", new_string: "b" } });
const verdict = (count, call = bash("npm test"), budget = 100) => budgetVerdict({ count, budget, call });

test("the budget is swarm.toolCallBudget, and one hundred calls without it", () => {
  assert.equal(DEFAULT_BUDGET, 100);
  assert.equal(budgetOf(), 100);
  assert.equal(budgetOf({}), 100);
  assert.equal(budgetOf({ toolCallBudget: 40 }), 40);
});

test("a budget that is not a positive whole number is a named config error", () => {
  for (const toolCallBudget of [0, -1, 2.5, "100"]) {
    assert.throws(() => budgetOf({ toolCallBudget }), /swarm\.toolCallBudget/);
  }
});

test("below seventy percent of the budget a call runs with no message", () => {
  assert.equal(verdict(1), null);
  assert.equal(verdict(69), null);
});

test("the reminder fires at seventy percent and every ten calls after, as model-visible context", () => {
  for (const count of [70, 80, 90]) {
    const output = verdict(count);
    assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
    const reminder = output.hookSpecificOutput.additionalContext;
    assert.match(reminder, new RegExp(`call ${count} of 100`));
    assert.match(reminder, /commit and push green work/);
    assert.match(reminder, /hand-off/);
  }
  assert.equal(verdict(71), null);
  assert.equal(verdict(89), null);
});

test("the reminder threshold rounds up for a small budget", () => {
  assert.equal(verdict(3, bash("npm test"), 5), null);
  assert.ok(verdict(4, bash("npm test"), 5).hookSpecificOutput.additionalContext);
});

test("at the budget and past it, a call outside the hand-off is denied with the hand-off steps", () => {
  for (const call of [bash("npm test"), bash("git status && pnpm test"), bash("git checkout main"), bash("git status > s.txt"), { tool_name: "Grep", tool_input: {} }, write("src/a.ts")]) {
    for (const count of [100, 101, 150]) {
      const output = verdict(count, call);
      assert.equal(output.hookSpecificOutput.permissionDecision, "deny", JSON.stringify(call));
      const reason = output.hookSpecificOutput.permissionDecisionReason;
      assert.match(reason, /commit and push green work/i);
      assert.match(reason, /hand-off note/);
      assert.match(reason, /final report/);
      assert.match(reason, /swarm\.toolCallBudget/);
    }
  }
});

test("at the budget, every call a hand-off needs still runs", () => {
  const handoff = [
    bash("git status"),
    bash("git diff --stat"),
    bash("git log --oneline -3 | head -3"),
    bash('git add -A && git commit -m "wip: stop here" && git push -u origin HEAD'),
    bash('git -C "C:/work/kit wt" commit -m "wip: a; b && c"'),
    bash("cd /work/wt && git push"),
    bash("git commit -F - <<'EOF'\nwip: stop; here && now\nEOF"),
    write("C:\\tmp\\scratch\\handoffs\\k1.md"),
    edit("/tmp/scratch/handoffs/k1.md"),
    { tool_name: "Read", tool_input: { file_path: "/work/wt/src/a.ts" } },
    { tool_name: "SubagentHandback", tool_input: { message: "done" } },
  ];
  for (const call of handoff) {
    assert.equal(isHandoffCall(call), true, JSON.stringify(call));
    assert.equal(verdict(100, call), null, JSON.stringify(call));
  }
});
