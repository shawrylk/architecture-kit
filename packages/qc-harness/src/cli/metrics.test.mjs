import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runMetrics } from "./metrics.mjs";

const now = () => Date.parse("2026-11-23T00:00:00Z");
const fixture = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-metrics-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  mkdirSync(path.join(dir, ".git", "qc"), { recursive: true });
  return { dir, file: path.join(dir, ".git", "qc", "runs.jsonl") };
};

test("metrics compares equal periods, ranks refusals and fixes, and skips bad lines within fifteen lines", (t) => {
  const { dir, file } = fixture(t);
  const rows = [];
  for (const role of ["scout", "tests", "implement", "review", "fix"]) {
    rows.push({ kind: "codex", time: "2026-11-10T00:00:00Z", role, exit: 4, inputTokens: 50, issue: 1, refusal: "old rule" });
    rows.push({ kind: "codex", time: "2026-11-20T00:00:00Z", role, exit: 0, inputTokens: role === "implement" ? 100.5 : 100, issue: 249 });
  }
  rows.push({ kind: "codex", time: "2026-11-21T00:00:00Z", role: "fix", exit: 4, inputTokens: 200, issue: 249, refusal: "guard refused: protected path" });
  rows.push({ kind: "codex", time: "2026-11-22T00:00:00Z", role: "fix", exit: 0, inputTokens: 0, issue: 42 });
  rows.push({ kind: "codex", time: "2026-11-24T00:00:00Z", role: "fix", exit: 4, inputTokens: 9999, issue: 999, refusal: "future rule" });
  rows.push({ kind: "ci", time: "2026-11-20T00:00:00Z", result: "pass", minutes: 2 });
  rows.push({ kind: "ci", time: "2026-11-21T00:00:00Z", result: "fail", minutes: 4 });
  writeFileSync(file, rows.map(JSON.stringify).join("\n") + "\nbad line\n");
  const lines = [];
  assert.equal(runMetrics(["--since", "2026-11-16"], { cwd: dir, now, say: line => lines.push(line) }), 0);
  const output = lines.join("\n");
  assert.match(output, /implement: runs 1 \(Δ \+0\), exit 0 100\.0% \(Δ \+100\.0pp\), exit 4 0\.0% \(Δ -100\.0pp\), mean input tokens 100\.5 \(Δ \+50\.5\)/);
  for (const role of ["scout", "tests", "implement", "review", "fix"]) assert.match(output, new RegExp(`^${role}:`, "m"));
  assert.match(output, /refusal: guard refused: protected path — 1/);
  assert.match(output, /fix issue: #249 — 2/);
  assert.match(output, /fix issue: #42 — 1/);
  assert.match(output, /CI: pass 50\.0%, mean minutes 3\.0/);
  assert.match(output, /skipped 1 bad lines$/);
  assert.doesNotMatch(output, /old rule|future rule|#999/);
  assert.ok(lines.length <= 15);
});

test("metrics defaults to seven days and routes lazily without loading invalid config", (t) => {
  const { dir, file } = fixture(t);
  writeFileSync(path.join(dir, "qc.config.json"), "invalid config");
  const qc = fileURLToPath(new URL("./qc.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [qc, "metrics"], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "no runs recorded");
  writeFileSync(file, JSON.stringify({ kind: "codex", time: "2026-11-15T23:59:59Z", role: "implement", exit: 0, inputTokens: 100 }) + "\n");
  const lines = [];
  assert.equal(runMetrics([], { cwd: dir, now, say: line => lines.push(line) }), 0);
  assert.ok(!lines.some(line => line.startsWith("implement:")));
  for (const argv of [["--since", "2026-02-30"], ["--since"], ["--other"], ["--since", "2026-11-24"]]) {
    assert.equal(runMetrics(argv, { cwd: dir, now, say() {}, warn() {} }), 1);
  }
});
