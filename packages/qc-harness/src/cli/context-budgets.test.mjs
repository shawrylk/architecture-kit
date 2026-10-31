import test from "node:test";
import assert from "node:assert/strict";
import { defaults, merge } from "../config.mjs";
import { budgetsOf } from "./context-budgets.mjs";

const configWith = (budgets) => merge(defaults, { budgets });

test("budgetsOf resolves the default budgets for every role", () => {
  assert.deepEqual(budgetsOf(defaults), {
    orchestrator: { compactAt: 200000 },
    implementer: { remindAt: 110000, handoffAt: 150000 },
    reviewer: { remindAt: 80000, handoffAt: 120000 },
    codex: { compactAt: 300000, toolOutputTokens: 4000 },
  });
});

test("unknown keys inside every budget role name the key in the error", () => {
  for (const role of ["orchestrator", "implementer", "reviewer", "codex"]) {
    assert.throws(() => budgetsOf(configWith({ [role]: { handOffAt: 200000 } })), {
      message: `budgets.${role}.handOffAt in qc.config.json must be a known key (${Object.keys(defaults.budgets[role]).join(", ")}), got 200000`,
    });
  }
});

test("a null role turns its budget off", () => {
  for (const role of ["orchestrator", "implementer", "reviewer", "codex"]) {
    assert.equal(budgetsOf(configWith({ [role]: null }))[role], null);
  }
});

test("budgets.implementer.remindAt must be a positive whole number", () => {
  assert.throws(() => budgetsOf(configWith({ implementer: { remindAt: 0 } })), {
    message: "budgets.implementer.remindAt in qc.config.json must be a positive whole number, got 0",
  });
});

test("each budget number must be a positive whole number", () => {
  const fields = {
    orchestrator: ["compactAt"],
    implementer: ["remindAt", "handoffAt"],
    reviewer: ["remindAt", "handoffAt"],
    codex: ["compactAt", "toolOutputTokens"],
  };
  for (const [role, keys] of Object.entries(fields)) {
    for (const key of keys) {
      for (const value of [0, -1, 1.5, "1000", false, [], {}]) {
        assert.throws(() => budgetsOf(configWith({ [role]: { [key]: value } })), {
          message: `budgets.${role}.${key} in qc.config.json must be a positive whole number, got ${JSON.stringify(value)}`,
        });
      }
      if (role !== "codex" || key !== "compactAt") {
        assert.throws(() => budgetsOf(configWith({ [role]: { [key]: null } })), {
          message: `budgets.${role}.${key} in qc.config.json must be a positive whole number, got null`,
        });
      }
    }
  }
});

test("remindAt must be smaller than handoffAt", () => {
  for (const [role, handoffAt] of [["implementer", 150000], ["reviewer", 120000]]) {
    for (const remindAt of [handoffAt, handoffAt + 1]) {
      assert.throws(() => budgetsOf(configWith({ [role]: { remindAt } })), {
        message: `budgets.${role}.remindAt in qc.config.json must be smaller than handoffAt (${handoffAt}), got ${remindAt}`,
      });
    }
  }
});

test("an unknown role error lists the supported roles", () => {
  assert.throws(() => budgetsOf(configWith({ planner: {} })), {
    message: "budgets.planner in qc.config.json must be a known role (orchestrator, implementer, reviewer, codex), got {}",
  });
});

test("budgets.codex must be an object or null", () => {
  for (const value of ["big", 10, false, []]) {
    assert.throws(() => budgetsOf(configWith({ codex: value })), {
      message: `budgets.codex in qc.config.json must be an object or null, got ${JSON.stringify(value)}`,
    });
  }
});

test("a null codex compactAt uses codex.compactTokens", () => {
  const config = merge(defaults, { codex: { compactTokens: 250000 }, budgets: { codex: { compactAt: null } } });
  assert.equal(budgetsOf(config).codex.compactAt, 250000);
  assert.equal(config.budgets.codex.compactAt, null);
});

test("a bad compactTokens fallback names codex.compactTokens", () => {
  for (const value of [0, -5, 1.5, "big", null]) {
    assert.throws(() => budgetsOf(merge(defaults, { codex: { compactTokens: value } })), {
      message: `codex.compactTokens in qc.config.json must be a positive whole number, got ${JSON.stringify(value)}`,
    });
  }
});
