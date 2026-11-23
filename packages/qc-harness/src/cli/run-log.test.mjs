import { strict as assert } from "node:assert";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appendRun, readRuns, runLogFileOf } from "./run-log.mjs";

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
    { kind: "ci", time: "2026-11-21T00:00:00.000Z", pr: 249, head: "abc", result: "pass", minutes: 1.2 },
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
