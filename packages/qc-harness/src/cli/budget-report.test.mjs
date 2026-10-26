import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { budgetReport, percentile, runBudget } from "./budget-report.mjs";
import { appendRecord, ledgerFileOf } from "./ledger.mjs";

const QC = fileURLToPath(new URL("./qc.mjs", import.meta.url));
const budgets = {
  implementer: { remindAt: 110_000, handoffAt: 150_000 },
  reviewer: { remindAt: 80_000, handoffAt: 120_000 },
};
const contexts = Array.from({ length: 10 }, (_, index) => 40_000 + index * 10_000);
const cost = (endContext, index, extra = {}) => ({
  type: "cost", session: "s", agentId: `agent-${index}`, role: "implementer",
  endContext, peakContext: endContext, ...extra,
});
const records = () => contexts.map((context, index) => cost(context, index));

test("percentile uses the nearest rank without changing the input", () => {
  const values = [...contexts].reverse();
  assert.equal(percentile(values, 50), 80_000);
  assert.equal(percentile(values, 90), 120_000);
  assert.deepEqual(values, [...contexts].reverse());
  assert.equal(percentile([60_000], 90), 60_000);
});

test("ten implementer tasks report their end context and keep handoffAt", () => {
  const [line] = budgetReport(records(), budgets);
  for (const text of ["implementer", "tasks 10", "median 80K", "p90 120K", "hit handoffAt 0 of 10 (0%)", "keep handoffAt"]) {
    assert.ok(line.includes(text), line);
  }
});

test("more than ten percent of peaks at handoffAt raises the limit", () => {
  const costs = records();
  costs[0].peakContext = 150_000;
  costs[1].peakContext = 160_000;
  const [line] = budgetReport(costs, budgets);
  assert.match(line, /hit handoffAt 2 of 10 \(20%\)/);
  assert.match(line, /raise handoffAt: more than 10% of tasks hand off/);
});

test("a p90 under half of handoffAt lowers the limit", () => {
  const [line] = budgetReport(contexts.map((_, index) => cost(50_000, index)), budgets);
  assert.match(line, /p90 50K/);
  assert.match(line, /hit handoffAt 0 of 10 \(0%\)/);
  assert.match(line, /lower handoffAt: the 90th percentile is under half of it/);
});

test("the raise rule takes priority over a low end context", () => {
  const costs = contexts.map((_, index) => cost(50_000, index, { peakContext: index < 2 ? 150_000 : 50_000 }));
  assert.match(budgetReport(costs, budgets)[0], /raise handoffAt/);
});

test("exactly ten percent and exactly half keep handoffAt", () => {
  const costs = records();
  costs[0].peakContext = 150_000;
  assert.match(budgetReport(costs, budgets)[0], /hit handoffAt 1 of 10 \(10%\).*keep handoffAt/);
  const half = contexts.map((_, index) => cost(75_000, index));
  assert.match(budgetReport(half, budgets)[0], /p90 75K.*keep handoffAt/);
});

test("cost records with no endContext are skipped and counted", () => {
  const old = Array.from({ length: 3 }, (_, index) => ({ type: "cost", session: "old", agentId: `old-${index}`, role: "implementer" }));
  const lines = budgetReport([...records(), ...old, { type: "stop", role: "implementer" }], budgets);
  assert.match(lines[0], /tasks 10/);
  assert.ok(lines.includes("skipped 3 cost records with no context figure"));
});

test("a role with no record reports the absence of context figures", () => {
  const lines = budgetReport(records(), budgets);
  assert.equal(lines[1], "reviewer: no cost record with context figures");
  assert.match(lines.at(-1), /orchestrator.*Codex.*no cost record/);
});

test("both cost review roles count as reviewer, after implementer", () => {
  const costs = [cost(80_000, 1, { role: "reviewer" }), cost(100_000, 2, { role: "branch-reviewer", peakContext: 120_000 })];
  const lines = budgetReport(costs, { reviewer: budgets.reviewer, implementer: budgets.implementer });
  assert.match(lines[0], /^implementer:/);
  assert.match(lines[1], /^reviewer:.*tasks 2.*median 80K.*p90 100K.*hit handoffAt 1 of 2 \(50%\).*raise handoffAt/);
});

test("only the newest cost record for each resumed agent counts", () => {
  const old = { type: "cost", session: "s", agentId: "agent-0", role: "implementer" };
  const lines = budgetReport([old, cost(160_000, 0), ...records(), cost(150_000, 0, { session: "another" })], budgets);
  assert.match(lines[0], /tasks 11.*hit handoffAt 1 of 11 \(9%\).*keep handoffAt/);
  assert.ok(lines.every((line) => !line.startsWith("skipped")));
});

test("null budgets omit the role", () => {
  const lines = budgetReport(records(), { ...budgets, implementer: null });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^reviewer:/);
});

function workspace(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-budget-report-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".git"));
  const nested = path.join(root, "packages", "app");
  mkdirSync(nested, { recursive: true });
  writeFileSync(path.join(root, "qc.config.json"), JSON.stringify({ budgets }));
  appendRecord(ledgerFileOf(root), cost(60_000, 0));
  return { root, nested };
}

test("runBudget reads the checkout ledger and resolved budgets", (t) => {
  const { nested } = workspace(t);
  const log = t.mock.method(console, "log", () => {});
  assert.equal(runBudget({ root: nested, budgets: { implementer: { remindAt: 70_000, handoffAt: 100_000 } } }, ["report"]), 0);
  const lines = log.mock.calls.map(({ arguments: args }) => args[0]);
  assert.match(lines[0], /implementer:.*tasks 1.*p90 60K.*keep handoffAt/);
  assert.match(lines[1], /^reviewer: no cost record/);
});

test("only the exact report subcommand is accepted", (t) => {
  const error = t.mock.method(console, "error", () => {});
  for (const args of [[], ["other"], ["report", "extra"]]) {
    assert.equal(runBudget({}, args), 1);
  }
  assert.equal(error.mock.calls.length, 3);
  for (const { arguments: args } of error.mock.calls) assert.match(args[0], /qc budget report/);
});

test("qc routes budget report and rejects an unknown budget subcommand", (t) => {
  const { nested } = workspace(t);
  const report = spawnSync(process.execPath, [QC, "budget", "report"], { cwd: nested, encoding: "utf8" });
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /implementer:.*tasks 1/);
  const invalid = spawnSync(process.execPath, [QC, "budget", "other"], { cwd: nested, encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /qc budget report/);
});
