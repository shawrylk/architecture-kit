import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { recordRun, openFailures, resolveFailures, ciBriefRefusal, lessonRefusal, lessonRules, rerunFailures, runCiFailures, parseFailedLog } from "./ci-failures.mjs";
import { holdRefusal, runResume } from "./pause.mjs";
import { appendRecord, ledgerFileOf, readLedger } from "./ledger.mjs";
import { runWatch } from "./watch.mjs";

const tap = `test (windows-latest)\tRun tests\t2026-01-01T00:00:00Z not ok 1 - cleanup retries
test (windows-latest)\tRun tests\t2026-01-01T00:00:00Z   ---
test (windows-latest)\tRun tests\t2026-01-01T00:00:00Z   location: 'file:///D:/a/repo/tests/cleanup.test.mjs:12:1'
test (windows-latest)\tRun tests\t2026-01-01T00:00:00Z   error: 'EBUSY: resource busy'
test (windows-latest)\tRun tests\t2026-01-01T00:00:00Z   ...`;

test("parses a Node spec reporter failure excerpt without duplicating its summary", () => {
  const log = `✖ cleanup retries (1.1624ms)
ℹ tests 1
ℹ fail 1

✖ failing tests:

test at qc-205-spec.test.mjs:1:72
✖ cleanup retries (1.1624ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  1 !== 2

      at TestContext.<anonymous> (file:///C:/Users/NGUYEN%7E1/AppData/Local/Temp/qc-205-spec.test.mjs:1:109)`;
  const failures = parseFailedLog(log);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].test, "cleanup retries");
  assert.equal(failures[0].file, "qc-205-spec.test.mjs");
  assert.match(failures[0].error, /AssertionError.*Expected values/);
});

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ci-lessons-"));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["remote", "add", "origin", "https://github.com/local/repo.git"], { cwd: root });
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

test("records the repository and holds only failures from the local origin", (t) => {
  const root = fixture(t);
  for (const [id, head] of [[1, "aaaaaaa"], [2, "bbbbbbb"], [3, "ccccccc"]]) {
    recordRun(root, { id, branch: "main", head }, { repo: "fork/repo", gh: () => tap });
  }
  assert.equal(readLedger(ledgerFileOf(root))[0].repository, "fork/repo");
  assert.equal(holdRefusal(root, "main"), null);
  for (const [id, head] of [[4, "ddddddd"], [5, "eeeeeee"], [6, "fffffff"]]) {
    recordRun(root, { id, branch: "main", head }, { gh: () => tap });
  }
  assert.equal(readLedger(ledgerFileOf(root)).at(-1).repository, "local/repo");
  assert.ok(holdRefusal(root, "main"));
});

test("watch isolates fork and explicit repositories when recording and resolving", async (t) => {
  const root = fixture(t);
  recordRun(root, { id: 1, branch: "main", head: "aaaaaaa" }, { gh: () => tap });
  for (const fork of [true, false]) {
    const repository = fork ? "fork/repo" : "other/repo";
    let conclusion = "failure";
    let head = "bbbbbbb";
    let id = 2;
    const gh = (args) => {
      if (args.includes("--log-failed")) return tap;
      if (args.includes(".sha")) return head;
      return JSON.stringify({ workflow_runs: [{ id, head_sha: head, head_branch: "main", status: "completed", conclusion,
        ...(fork ? { head_repository: { full_name: repository }, repository: { full_name: "local/repo" } } : {}) }] });
    };
    const watch = () => runWatch(["--run", "ci.yml@main", ...(!fork ? ["--repo", repository] : [])], {
      cwd: root, requiredChecks: [], gh, say: () => {}, warn: () => {},
    });
    for (const sha of ["bbbbbbb", "ccccccc", "ddddddd"]) {
      head = sha;
      id += 1;
      assert.equal(await watch(), 5);
    }
    assert.equal(holdRefusal(root, "main"), null);
    assert.equal(openFailures(root, "main", repository).length, 3);
    conclusion = "success";
    head = "eeeeeee";
    id += 1;
    assert.equal(await watch(), 0);
    assert.equal(openFailures(root, "main", repository).length, 0);
    assert.equal(openFailures(root, "main").length, 1);
  }
});

test("a local branch hold leaves an explicit foreign repository watch available", async (t) => {
  const root = fixture(t);
  for (const [id, head] of [[1, "aaaaaaa"], [2, "bbbbbbb"], [3, "ccccccc"]]) recordRun(root, { id, branch: "main", head }, { gh: () => tap });
  assert.ok(holdRefusal(root, "main"));
  assert.equal(await runWatch(["--run", "ci.yml@main", "--repo", "other/repo"], { cwd: root, requiredChecks: [], say: () => {},
    gh: (args) => args.includes(".sha") ? "ddddddd" : JSON.stringify({ workflow_runs: [{ id: 4, head_sha: "ddddddd", status: "completed", conclusion: "success" }] }),
  }), 0);
});

test("open failures require lessons when their branch merges into the base", (t) => {
  const root = fixture(t);
  const git = (...args) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: root, encoding: "utf8" }).trim();
  git("commit", "--allow-empty", "-qm", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-qb", "feat/merged");
  git("commit", "--allow-empty", "-qm", "branch");
  recordRun(root, { id: 1, branch: "feat/merged", head: git("rev-parse", "HEAD") }, { gh: () => tap });
  assert.equal(lessonRefusal(root, "feat/merged", ""), null);
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  assert.equal(openFailures(root, "feat/merged").length, 1);
  assert.match(lessonRefusal(root, "feat/merged", ""), /cleanup retries/);
  assert.equal(lessonRefusal(root, "feat/merged", "## cleanup retries\nSymptom: EBUSY\nCause: open handle\nRule: Close it.\n"), null);
});

test("foreign resolutions leave legacy local records open", (t) => {
  const root = fixture(t);
  appendRecord(ledgerFileOf(root), { type: "ci-failure", id: "legacy", branch: "main", head: "aaaaaaa", test: "legacy" });
  resolveFailures(root, "main", "bbbbbbb", 2, "fork/repo");
  assert.equal(openFailures(root, "main").length, 1);
});

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

test("resolved tests require complete lesson entries and rules feed forward newest first, capped at twenty", (t) => {
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
  assert.equal(rules.length, 20);
  assert.equal(rules[0], "Rule: Apply rule 44.");
  assert.equal(rules.at(-1), "Rule: Apply rule 25.");
});

test("prompt rules trim duplicates and skip none declarations before applying the caps", (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, "lessons.md"), "Rule: Older\nRule: Same\n Rule: Same  \nRule: none: no lesson\nRule: Same\nRule: Newest\n");
  assert.deepEqual(lessonRules(root, { file: "lessons.md" }), ["Rule: Newest", "Rule: Same", "Rule: Older"]);
});

test("prompt rules count separators in the character cap and leave overflowing rules whole", (t) => {
  const root = fixture(t);
  const newest = `Rule: ${"x".repeat(1994)}`;
  writeFileSync(path.join(root, "lessons.md"), `Rule: Older\n${newest}\n`);
  assert.deepEqual(lessonRules(root, { file: "lessons.md" }), [newest]);
  writeFileSync(path.join(root, "lessons.md"), `Rule: Older\n${newest}x\n`);
  assert.deepEqual(lessonRules(root, { file: "lessons.md" }), []);
  writeFileSync(path.join(root, "lessons.md"), `Rule: ${"a".repeat(992)}\nRule: ${"b".repeat(995)}\n`);
  const rules = lessonRules(root, { file: "lessons.md" });
  assert.equal(rules.length, 2);
  assert.equal(rules.join("\n").length, 2000);
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
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
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

test("CI commands pass silently and refusals fit four lines", (t) => {
  const root = fixture(t);
  const output = [];
  const options = { say: (s) => output.push(s), warn: (s) => output.push(s), gh: () => JSON.stringify({ headBranch: "feat/test", headSha: "bbbbbbb", conclusion: "success" }) };
  assert.equal(runCiFailures(root, ["--run", "42"], options), 0);
  assert.deepEqual(output, []);
  assert.equal(runCiFailures(root, ["--rerun", "--branch", "green"], options), 0);
  assert.deepEqual(output, []);
  assert.equal(runCiFailures(root, [], options), 1);
  assert.ok(output.join("\n").split(/\r?\n/).length <= 4);
});

test("CI brief and lesson refusals keep multiline test names within four lines", (t) => {
  const root = fixture(t);
  appendRecord(ledgerFileOf(root), { type: "ci-failure", id: "multiline", branch: "feat/test", head: "aaaaaaa", test: "first\nsecond\nthird\nfourth\nfifth" });
  assert.ok(ciBriefRefusal(root, "feat/test", "").split(/\r?\n/).length <= 4);
  resolveFailures(root, "feat/test", "bbbbbbb");
  assert.ok(lessonRefusal(root, "feat/test", "").split(/\r?\n/).length <= 4);
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


test("rerun skips unresolved files and normalizes runner prefixes before resolution", (t) => {
  const root = fixture(t);
  mkdirSync(path.join(root, "tests"));
  writeFileSync(path.join(root, "tests/a.test.mjs"), "");
  const prefixes = ["/home/runner/work/r/r/", "/__w/r/r/", "D:\\a\\r\\r\\"];
  for (const [i, prefix] of prefixes.entries()) {
    appendRecord(ledgerFileOf(root), { type: "ci-failure", id: `prefix-${i}`, branch: "prefix", file: `${prefix}tests/a.test.mjs`, test: "a" });
  }
  const warnings = [];
  const calls = [];
  assert.equal(rerunFailures(root, "prefix", { rerun: "node --test" }, {
    warn: (s) => warnings.push(s), run: (command) => { calls.push(command); return { status: 0 }; },
  }), 0);
  assert.deepEqual(calls, ['node --test "tests/a.test.mjs"']);
  assert.deepEqual(warnings, []);
  appendRecord(ledgerFileOf(root), { type: "ci-failure", id: "missing", branch: "missing", file: "tests/old.test.mjs", test: "old" });
  assert.equal(rerunFailures(root, "missing", { rerun: "node --test" }, {
    warn: (s) => warnings.push(s), run: () => assert.fail("missing files must be skipped"),
  }), 0);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].split(/\r?\n/).length, 1);
  assert.match(warnings[0], /skip.*tests\/old.test.mjs/);
});

test("rerun captures passing output and caps failures at four lines", (t) => {
  const root = fixture(t);
  mkdirSync(path.join(root, "tests"));
  const file = path.join(root, "tests/a.test.mjs");
  writeFileSync(file, 'import test from "node:test"; test("passes", () => {});');
  appendRecord(ledgerFileOf(root), { type: "ci-failure", id: "output", branch: "main", file: "tests/a.test.mjs", test: "recorded failure" });
  const qc = fileURLToPath(new URL("./qc.mjs", import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"));
  const invoke = () => spawnSync(process.execPath, [qc, "ci-failures", "--rerun", "--branch", "main"], { cwd: root, encoding: "utf8", env });
  const pass = invoke();
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(pass.stdout, "");
  assert.equal(pass.stderr, "");
  writeFileSync(file, 'import test from "node:test"; for (let i=0; i<8; i++) test(`failed ${i}`, () => { throw new Error("detail"); });');
  const fail = invoke();
  assert.equal(fail.status, 1);
  assert.equal(fail.stdout, "");
  assert.ok(fail.stderr.trim().split(/\r?\n/).length <= 4, fail.stderr);
  assert.match(fail.stderr, /failed 0/);
  assert.match(fail.stderr, /node --test.*tests\/a.test.mjs/);
});

test("rerun skips unsafe existing paths and paths that cannot resolve", (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, "bad;name.test.mjs"), "");
  appendRecord(ledgerFileOf(root), { type: "ci-failure", id: "unsafe", branch: "unsafe", file: "bad;name.test.mjs", test: "unsafe" });
  const unsafeWarnings = [];
  assert.equal(rerunFailures(root, "unsafe", { rerun: "node --test" }, { warn: (s) => unsafeWarnings.push(s), run: () => assert.fail("unsafe") }), 0);
  assert.equal(unsafeWarnings.length, 1);
  assert.match(unsafeWarnings[0], /skip 1 test file:.*bad;name\.test\.mjs/);
  assert.ok(unsafeWarnings[0].length <= 200);
  writeFileSync(path.join(root, "plain"), "");
  appendRecord(ledgerFileOf(root), { type: "ci-failure", id: "unresolved", branch: "unresolved", file: "plain/a.test.mjs", test: "unresolved" });
  const warnings = [];
  assert.equal(rerunFailures(root, "unresolved", { rerun: "node --test" }, { warn: (s) => warnings.push(s), run: () => assert.fail("unresolved") }), 0);
  assert.equal(warnings.length, 1);
});


test("rerun preserves folders named a in Linux and relative paths", (t) => {
  const root = fixture(t);
  mkdirSync(path.join(root, "src/a/b"), { recursive: true });
  writeFileSync(path.join(root, "src/a/b/c.test.mjs"), "");
  for (const [i, file] of ["/home/runner/work/r/r/src/a/b/c.test.mjs", "file:///home/runner/work/r/r/src/a/b/c.test.mjs", "src/a/b/c.test.mjs"].entries()) {
    appendRecord(ledgerFileOf(root), { type: "ci-failure", id: `nested-${i}`, branch: "nested", file, test: "nested" });
  }
  const calls = [];
  assert.equal(rerunFailures(root, "nested", { rerun: "node --test" }, {
    warn: () => assert.fail("existing file must run"), run: (command) => { calls.push(command); return { status: 0 }; },
  }), 0);
  assert.deepEqual(calls, ['node --test "src/a/b/c.test.mjs"']);
});

test("rerun folds all skips into one line and keeps failed output within four lines", (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, "a.test.mjs"), "");
  for (const [i, file] of ["missing1.test.mjs", "missing2.test.mjs", "a.test.mjs"].entries()) {
    appendRecord(ledgerFileOf(root), { type: "ci-failure", id: `cap-${i}`, branch: "cap", file, test: `failure ${i}` });
  }
  for (const status of [0, 1]) {
    const warnings = [];
    assert.equal(rerunFailures(root, "cap", { rerun: "node --test" }, {
      warn: (s) => warnings.push(s), run: () => ({ status }),
    }), status);
    assert.equal(warnings.filter((s) => /skip/.test(s)).length, 1);
    assert.match(warnings[0], /missing1.*missing2/);
    assert.ok(warnings.join("\n").split(/\r?\n/).length <= (status ? 4 : 1), warnings.join("\n"));
    if (status) {
      assert.match(warnings[1], /failure 2/);
      assert.doesNotMatch(warnings.slice(1).join("\n"), /failure [01]/);
    }
  }
});

test("the skip line stays within 200 characters for many long paths", (t) => {
  const root = fixture(t);
  for (let i = 0; i < 10; i += 1) appendRecord(ledgerFileOf(root), {
    type: "ci-failure", id: `long-${i}`, branch: "long", file: `${"x".repeat(100)}-${i}.test.mjs`, test: "missing",
  });
  const warnings = [];
  assert.equal(rerunFailures(root, "long", { rerun: "node --test" }, { warn: (s) => warnings.push(s) }), 0);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].length <= 200);
  assert.match(warnings[0], /skip 10 test files:/);
});
