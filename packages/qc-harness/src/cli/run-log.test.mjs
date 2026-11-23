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
  assert.throws(() => readRuns(path.join(file, "child")));
});


test("run log redacts every branch, PR and workflow text field", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-run-fields-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = path.join(dir, "runs.jsonl");
  const secrets = [
    `AKIA${"A".repeat(16)}`, `aws_secret_access_key=${"a".repeat(40)}`,
    `ghp_${"a".repeat(36)}`, `github_pat_${"a".repeat(40)}`,
    ["-----BEGIN", "PRIVATE KEY-----"].join(" "), `sk-ant-${"a".repeat(20)}`,
    `xoxb-${"a".repeat(10)}`, `npm_${"a".repeat(36)}`,
    os.hostname(), "private.example.com", "https://internal/path", "\\\\internal\\share",
  ];
  for (const secret of secrets) {
    appendRun(file, { kind: "ci", time: "2026-11-21T00:00:00Z", result: "pass", minutes: 1,
      branch: `topic/${secret}`, pr: secret, run: `workflow/${secret}` });
  }
  const { runs } = readRuns(file);
  assert.equal(runs.length, secrets.length);
  for (const row of runs) for (const field of ["branch", "pr", "run"]) assert.equal(row[field], "[REDACTED]");
});
