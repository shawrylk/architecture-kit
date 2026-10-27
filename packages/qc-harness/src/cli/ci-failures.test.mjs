import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { recordRun, openFailures, resolveFailures, ciBriefRefusal, lessonRefusal, lessonRules, rerunFailures, runCiFailures, parseFailedLog } from "./ci-failures.mjs";
import { holdRefusal, runResume } from "./pause.mjs";
import { ledgerFileOf, readLedger } from "./ledger.mjs";
import { runWatch } from "./watch.mjs";

const tap = `test (windows-latest)\tRun tests\t2026-01-01T00:00:00Z not ok 1 - cleanup retries
test (windows-latest)\tRun tests\t2026-01-01T00:00:00Z   ---
test (windows-latest)\tRun tests\t2026-01-01T00:00:00Z   location: 'file:///D:/a/repo/tests/cleanup.test.mjs:12:1'
test (windows-latest)\tRun tests\t2026-01-01T00:00:00Z   error: 'EBUSY: resource busy'
test (windows-latest)\tRun tests\t2026-01-01T00:00:00Z   ...`;

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ci-lessons-"));
  execFileSync("git", ["init", "-q", root]);
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

test("records TAP failures once per run and resolves only on a later head of the same branch", (t) => {
  const root = fixture(t);
  const gh = (args) => {
    assert.deepEqual(args, ["run", "view", "42", "--log-failed"]);
    return tap;
  };
  recordRun(root, { id: 42, branch: "feat/test", head: "aaaaaaa" }, { gh });
  recordRun(root, { id: 42, branch: "feat/test", head: "aaaaaaa" }, { gh });
  const records = readLedger(ledgerFileOf(root));
  assert.equal(records.length, 1);
  assert.equal(records[0].test, "cleanup retries");
  assert.equal(records[0].os, "windows-latest");
  assert.equal(records[0].file, "tests/cleanup.test.mjs");
  assert.equal(records[0].error, "EBUSY: resource busy");
  resolveFailures(root, "other", "bbbbbbb");
  resolveFailures(root, "feat/test", "aaaaaaa");
  assert.equal(openFailures(root, "feat/test").length, 1);
  resolveFailures(root, "feat/test", "bbbbbbb");
  assert.equal(openFailures(root, "feat/test").length, 0);
});

test("records unknown output by job and records nothing when gh fails", (t) => {
  const root = fixture(t);
  const warnings = [];
  recordRun(root, { id: 1, branch: "main", head: "aaaaaaa" }, { gh: () => { throw new Error("network\nsecret"); }, warn: (s) => warnings.push(s) });
  assert.equal(readLedger(ledgerFileOf(root)).length, 0);
  assert.deepEqual(warnings, ["ci-failures: gh failed: network"]);
  recordRun(root, { id: 2, branch: "main", head: "aaaaaaa" }, { gh: () => "build (ubuntu-latest)\tBuild\t2026-01-01T00:00:00Z ##[error]compiler failed" });
  const [failure] = openFailures(root, "main");
  assert.equal(failure.test, "build (ubuntu-latest)");
  assert.match(failure.error, /compiler failed/);
});

test("watch records a failed run, preserves exit 5 on a log error, and resolves a later green head", async (t) => {
  const root = fixture(t);
  let failedLog = false;
  let head = "aaaaaaa";
  let conclusion = "failure";
  const gh = (args) => {
    if (args.includes("--log-failed")) {
      if (failedLog) throw new Error("log unavailable");
      return tap;
    }
    if (args.includes(".sha")) return head;
    return JSON.stringify({ workflow_runs: [{ id: conclusion === "success" ? 43 : 42, head_sha: head, head_branch: "feat/test", status: "completed", conclusion }] });
  };
  const warnings = [];
  const watch = () => runWatch(["--run", "ci.yml@feat/test"], { cwd: root, requiredChecks: [], gh, say: () => {}, warn: (s) => warnings.push(s) });
  assert.equal(await watch(), 5);
  assert.equal(openFailures(root, "feat/test").length, 1);
  failedLog = true;
  assert.equal(await watch(), 5);
  assert.equal(warnings.length, 1);
  head = "bbbbbbb";
  conclusion = "success";
  assert.equal(await watch(), 0);
  assert.equal(openFailures(root, "feat/test").length, 0);
});

test("repeat heads require diagnosis, third heads hold only that branch, and resume alone preserves the hold", (t) => {
  const root = fixture(t);
  const record = (id, head, log = tap) => recordRun(root, { id, branch: "feat/test", head }, { gh: () => log });
  record(1, "aaaaaaa");
  assert.match(ciBriefRefusal(root, "feat/test", ""), /cleanup retries/);
  assert.equal(ciBriefRefusal(root, "green", ""), null);
  const brief = "## CI failures\n### cleanup retries\nCause: the file remains open.\n";
  assert.equal(ciBriefRefusal(root, "feat/test", brief), null);
  assert.match(ciBriefRefusal(root, "feat/test", brief.replace("Cause:", "Reason:")), /Cause:/);
  record(2, "aaaaaaa");
  assert.equal(ciBriefRefusal(root, "feat/test", brief), null);
  record(3, "bbbbbbb");
  assert.match(ciBriefRefusal(root, "feat/test", brief), /## Diagnosis/);
  assert.match(ciBriefRefusal(root, "feat/test", `${brief}\n## Diagnosis\nRoot cause: open handle\n`), /Evidence:/);
  assert.equal(ciBriefRefusal(root, "feat/test", `${brief}\n## Diagnosis\nRoot cause: open handle\nEvidence: log shows EBUSY; cleanup code leaves it open.\n`), null);
  record(4, "ccccccc");
  assert.match(holdRefusal(root, "feat/test"), /operator.*qc resume --branch feat\/test/i);
  assert.equal(holdRefusal(root, "other"), null);
  assert.equal(runResume(root, [], { say: () => {} }), 0);
  assert.ok(holdRefusal(root, "feat/test"));
  assert.equal(runResume(root, ["--branch", "feat/test"], { say: () => {} }), 0);
  assert.equal(holdRefusal(root, "feat/test"), null);
});

test("resolved tests require complete lesson entries and rules feed forward newest first, capped at forty", (t) => {
  const root = fixture(t);
  recordRun(root, { id: 1, branch: "feat/test", head: "aaaaaaa" }, { gh: () => tap });
  assert.equal(lessonRefusal(root, "feat/test", ""), null);
  resolveFailures(root, "feat/test", "bbbbbbb");
  assert.match(lessonRefusal(root, "feat/test", ""), /cleanup retries/);
  assert.match(lessonRefusal(root, "feat/test", "## cleanup retries\nSymptom: EBUSY on Windows\nCause: open handle\nRule:\n"), /cleanup retries/);
  assert.equal(lessonRefusal(root, "feat/test", "## cleanup retries\nSymptom: EBUSY on Windows\nCause: open handle\nRule: Retry cleanup.\n"), null);
  assert.equal(lessonRefusal(root, "other", ""), null);
  mkdirSync(path.join(root, "docs"));
  writeFileSync(path.join(root, "docs", "ci-lessons.md"), Array.from({ length: 45 }, (_, i) => `## test ${i}\nRule: Apply rule ${i}.\n`).join("\n"));
  const rules = lessonRules(root, { file: "docs/ci-lessons.md" });
  assert.equal(rules.length, 40);
  assert.equal(rules[0], "Rule: Apply rule 44.");
  assert.equal(rules.at(-1), "Rule: Apply rule 5.");
});

test("rerun appends unique open test files, honors configuration, and propagates failures", (t) => {
  const root = fixture(t);
  mkdirSync(path.join(root, "tests"));
  writeFileSync(path.join(root, "tests", "cleanup.test.mjs"), "");
  recordRun(root, { id: 1, branch: "feat/test", head: "aaaaaaa" }, { gh: () => tap });
  recordRun(root, { id: 2, branch: "feat/test", head: "aaaaaaa" }, { gh: () => tap });
  const calls = [];
  const run = (command, options) => { calls.push({ command, options }); return { status: 7 }; };
  assert.equal(rerunFailures(root, "feat/test", { rerun: "node --test --test-reporter=tap" }, { run }), 7);
  assert.equal(calls.length, 1);
  assert.match(calls[0].command, /^node --test --test-reporter=tap .*tests\/cleanup.test.mjs/);
  assert.equal(calls[0].command.match(/cleanup.test.mjs/g).length, 1);
  assert.equal(calls[0].options.cwd, root);
  assert.equal(rerunFailures(root, "green", { rerun: "node --test" }, { run: () => assert.fail("green branch") }), 0);
});

test("a held watched branch exits 5 without fetching and leaves other branches available", async (t) => {
  const root = fixture(t);
  for (const [id, head] of [[1, "aaaaaaa"], [2, "bbbbbbb"], [3, "ccccccc"]]) recordRun(root, { id, branch: "feat/test", head }, { gh: () => tap });
  assert.equal(await runWatch(["--run", "ci.yml@feat/test"], { cwd: root, requiredChecks: [], gh: () => assert.fail("held branch"), say: () => {} }), 5);
});

test("the command table exposes ci-failures and reruns a green branch without gh", (t) => {
  const root = fixture(t);
  const qc = fileURLToPath(new URL("./qc.mjs", import.meta.url));
  const help = spawnSync(process.execPath, [qc], { cwd: root, encoding: "utf8" });
  assert.match(help.stdout, /qc ci-failures --run <id>/);
  const result = spawnSync(process.execPath, [qc, "ci-failures", "--rerun", "--branch", "green"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("manual recording reads run metadata with a fake gh", (t) => {
  const root = fixture(t);
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    return args.includes("--log-failed") ? tap : JSON.stringify({ headBranch: "feat/test", headSha: "aaaaaaa", conclusion: "failure" });
  };
  assert.equal(runCiFailures(root, ["--run", "42"], { gh, say: () => {} }), 0);
  assert.equal(openFailures(root, "feat/test").length, 1);
  assert.deepEqual(calls[0], ["run", "view", "42", "--json", "headBranch,headSha,conclusion"]);
});

test("recorded Linux TAP normalizes the checkout prefix and preserves the first multiline error", () => {
  const log = `test (ubuntu-latest)\tRun\t2026-01-01T00:00:00Z not ok 1 - rejects the wrong target
test (ubuntu-latest)\tRun\t2026-01-01T00:00:00Z   location: '/home/runner/work/architecture-kit/architecture-kit/packages/qc-harness/src/cli/auth.test.mjs:19:1'
test (ubuntu-latest)\tRun\t2026-01-01T00:00:00Z   error: |-
test (ubuntu-latest)\tRun\t2026-01-01T00:00:00Z     Expected values to be strictly equal:
test (ubuntu-latest)\tRun\t2026-01-01T00:00:00Z     false !== true`;
  const [failure] = parseFailedLog(log);
  assert.equal(failure.file, "packages/qc-harness/src/cli/auth.test.mjs");
  assert.equal(failure.error, "Expected values to be strictly equal:");
});

test("recorded Windows TAP accepts escaped drive paths", () => {
  const log = String.raw`test (windows-latest)\tRun\t2026-01-01T00:00:00Z not ok 1 - cleanup retries
test (windows-latest)\tRun\t2026-01-01T00:00:00Z   location: 'D:\\a\\architecture-kit\\architecture-kit\\packages\\qc-harness\\cleanup.test.mjs:12:1'
test (windows-latest)\tRun\t2026-01-01T00:00:00Z   error: EBUSY`.replaceAll("\\t", "\t");
  assert.equal(parseFailedLog(log)[0].file, "packages/qc-harness/cleanup.test.mjs");
});

test("a cause belongs to each named failure, and a missing test on the next head resets its repeat", (t) => {
  const root = fixture(t);
  recordRun(root, { id: 1, branch: "feat/test", head: "aaaaaaa" }, { gh: () => "not ok 1 - first test\n  error: first\nnot ok 2 - second test\n  error: second" });
  assert.match(ciBriefRefusal(root, "feat/test", "## CI failures\nfirst test\nsecond test\nCause: second only\n"), /first test/);
  recordRun(root, { id: 2, branch: "feat/test", head: "bbbbbbb" }, { gh: () => "not ok 1 - different test\n  error: other" });
  recordRun(root, { id: 3, branch: "feat/test", head: "ccccccc" }, { gh: () => "not ok 1 - first test\n  error: first" });
  const body = "## CI failures\n### first test\nCause: first\n### second test\nCause: second\n### different test\nCause: different\n";
  assert.equal(ciBriefRefusal(root, "feat/test", body), null);
  assert.equal(holdRefusal(root, "feat/test"), null);
});

test("blank lesson and brief fields stay blank when another field follows", (t) => {
  const root = fixture(t);
  recordRun(root, { id: 1, branch: "feat/test", head: "aaaaaaa" }, { gh: () => "not ok 1 - cleanup retries\n  error: EBUSY" });
  assert.match(ciBriefRefusal(root, "feat/test", "## CI failures\ncleanup retries\nCause:\nRule: retry\n"), /Cause:/);
  resolveFailures(root, "feat/test", "bbbbbbb");
  assert.match(lessonRefusal(root, "feat/test", "## cleanup retries\nSymptom: EBUSY on Windows\nCause:\nRule: Retry cleanup.\n"), /cleanup retries/);
});

test("an older green run cannot resolve a newer failure, and a manual log error returns failure", (t) => {
  const root = fixture(t);
  recordRun(root, { id: 20, branch: "feat/test", head: "aaaaaaa" }, { gh: () => tap });
  resolveFailures(root, "feat/test", "bbbbbbb", 10);
  assert.equal(openFailures(root, "feat/test").length, 1);
  resolveFailures(root, "feat/test", "ccccccc", 30);
  assert.equal(openFailures(root, "feat/test").length, 0);
  const warnings = [];
  const gh = (args) => {
    if (args.includes("--log-failed")) throw new Error("log unavailable\nmore detail");
    return JSON.stringify({ headBranch: "feat/test", headSha: "ddddddd", conclusion: "failure" });
  };
  assert.equal(runCiFailures(root, ["--run", "40"], { gh, say: () => {}, warn: (s) => warnings.push(s) }), 1);
  assert.deepEqual(warnings, ["ci-failures: gh failed: log unavailable"]);
});
