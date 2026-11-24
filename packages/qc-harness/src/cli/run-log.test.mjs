import { strict as assert } from "node:assert";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appendRun, readRuns, RUN_FIELDS, runLogFileOf } from "./run-log.mjs";

test("run lines share the git common directory, append, and count malformed records", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-run-log-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(dir, "root");
  const linked = path.join(dir, "linked");
  const gitDir = path.join(root, ".git", "worktrees", "linked");
  mkdirSync(gitDir, { recursive: true });
  mkdirSync(linked);
  writeFileSync(path.join(linked, ".git"), `gitdir: ${gitDir}\n`);
  writeFileSync(path.join(gitDir, "commondir"), "../..\n");
  const file = runLogFileOf(root);
  assert.equal(runLogFileOf(linked), file);
  assert.equal(runLogFileOf(dir), null);
  assert.deepEqual(readRuns(file), { runs: [], skipped: 0 });
  const rows = [
    { kind: "codex", time: "2026-11-20T00:00:00.000Z", role: "implement", exit: 0 },
    { kind: "ci", time: "2026-11-21T00:00:00.000Z", pr: 249, head: "abcdef0", result: "pass", minutes: 1.2 },
  ];
  appendRun(file, rows[0]);
  appendFileSync(file, "bad\nnull\n[]\n{}\n");
  appendRun(file, rows[1]);
  assert.deepEqual(readRuns(file), { runs: rows, skipped: 4 });
  assert.throws(() => readRuns(path.dirname(file)), /EISDIR|EPERM|EACCES/);
});


test("run log keeps only allowlisted branch, PR and workflow fields", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-run-fields-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = path.join(dir, "runs.jsonl");
  const redacted = "[REDACTED]";
  const secrets = [
    `AKIA${"A".repeat(16)}`, `aws_secret_access_key=${"a".repeat(40)}`,
    `ghp_${"a".repeat(36)}`, `github_pat_${"a".repeat(40)}`,
    ["-----BEGIN", "PRIVATE KEY-----"].join(" "), `sk-ant-${"a".repeat(20)}`,
    `xoxb-${"a".repeat(10)}`, `npm_${"a".repeat(36)}`,
    "private.example.com", "https://internal/path", "\\\\internal\\share",
  ];
  const rejected = [
    "topic/\u4f8b\u5b50.\u6d4b\u8bd5", "topic/private.example.com_release", "topic/10.20.30.40",
    "topic/fe80::1", "/tmp/x", "../x", "C:\\x", "a b", "release/1.2.3", "fix/readme.md",
    "", "topic\n", "topic/", "topic//x", "a".repeat(101), ...secrets.map((secret) => `topic/${secret}`),
  ];
  const cases = [
    ["branch", "feat/249-run-metrics", "feat/249-run-metrics"],
    ["branch", "a".repeat(100), "a".repeat(100)],
    ["run", "ci.yml@feat/249-x", "ci.yml@feat/249-x"],
    ["run", `ci.yml@topic@${"a".repeat(40)}`, `ci.yml@topic@${"a".repeat(40)}`],
    ["run", "ci.yaml@topic@abcdef0", "ci.yaml@topic@abcdef0"],
    ["pr", 254, 254],
    ["pr", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ...rejected.flatMap((value) => [["branch", value, redacted], ["run", `ci.yml@${value}`, redacted]]),
    ...secrets.map((value) => ["pr", value, redacted]),
    ...["12", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, true, {}, []]
      .map((value) => ["pr", value, redacted]),
    ...["/tmp/ci.yml@feat/x", "ci.yml@topic@abcdef", `ci.yml@topic@${"a".repeat(41)}`,
      "ci.yml@topic@ABCDEF0", "ci.yml@topic@abcdef0@abcdef0", "ci.txt@topic", "ci.yml\n@topic", "ci.yml@topic@abcdef0\n", "topic", 254]
      .map((value) => ["run", value, redacted]),
    ...[254, null, true, {}, []].map((value) => ["branch", value, redacted]),
  ];
  for (const [field, value] of cases) {
    appendRun(file, { kind: "ci", time: "2026-11-21T00:00:00Z", result: "pass", minutes: 1,
      [field]: value });
  }
  const { runs } = readRuns(file);
  assert.equal(runs.length, cases.length);
  for (const [index, [field, value, expected]] of cases.entries()) {
    assert.equal(runs[index][field], expected, `${field}: ${JSON.stringify(value)}`);
  }
});


test("run log drops unknown fields without changing the caller's record", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-run-unknown-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = path.join(dir, "runs.jsonl");
  const row = { kind: "ci", time: "2026-11-21T00:00:00Z", result: "pass", minutes: 1 };
  const record = { ...row, unexpected: "private data" };
  appendRun(file, record);
  assert.deepEqual(readRuns(file).runs, [row]);
  assert.equal(record.unexpected, "private data");
});

test("run log keeps lowercase hexadecimal heads of 7 to 40 characters", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-run-good-head-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = path.join(dir, "runs.jsonl");
  const heads = ["abcdef0", "0123456789abcdef", "a".repeat(40)];
  for (const head of heads) {
    appendRun(file, { kind: "ci", time: "2026-11-21T00:00:00Z", result: "pass", minutes: 1, head });
  }
  assert.deepEqual(readRuns(file).runs.map((row) => row.head), heads);
});

test("run log redacts heads with invalid content or types", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-run-bad-head-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = path.join(dir, "runs.jsonl");
  const heads = ["", "abcdef", "a".repeat(41), "ABCDEF0", "abcdefg", "abcdef0\n",
    " abcdef0", "abcdef0 ", "private.example.com", 1234567, null, true, {}, [], undefined];
  for (const head of heads) {
    appendRun(file, { kind: "ci", time: "2026-11-21T00:00:00Z", result: "pass", minutes: 1, head });
  }
  assert.deepEqual(readRuns(file).runs.map((row) => row.head), heads.map(() => "[REDACTED]"));
});


test("run fields exports the frozen field contract", () => {
  assert.equal(Object.isFrozen(RUN_FIELDS), true);
  assert.deepEqual(RUN_FIELDS, [
    "kind", "time", "branch", "issue", "role", "effort", "exit", "refusal", "inputTokens",
    "outputTokens", "minutes", "verify", "live", "verdict", "findings", "pr", "run", "head", "result", "changedLines", "maxDiffLines",
  ]);
});

test("new measurement fields validate numbers and enums without fabricating legacy values", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-run-measurements-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = path.join(dir, "runs.jsonl");
  const legacy = { kind: "codex", time: "2026-11-21T00:00:00Z", role: "fix", exit: 4 };
  appendRun(file, legacy);
  const measured = { ...legacy, verdict: "CHANGES_REQUIRED", findings: 2, changedLines: 401, maxDiffLines: 400 };
  appendRun(file, measured);
  assert.deepEqual(readRuns(file).runs, [legacy, measured]);
  for (const field of ["findings", "changedLines", "maxDiffLines", "verdict"]) {
    const values = field === "verdict" ? ["bad", 1, {}] : [-1, Infinity, NaN, "1", {}];
    for (const value of values) {
      appendRun(file, { ...legacy, [field]: value });
      assert.equal(readRuns(file).runs.at(-1)[field], null);
      appendFileSync(file, JSON.stringify({ ...legacy, [field]: typeof value === "number" && !Number.isFinite(value) ? -1 : value }) + "\n");
    }
  }
  const loaded = readRuns(file);
  assert.equal(loaded.skipped, 18);
  assert.deepEqual(loaded.runs[0], legacy);
});
