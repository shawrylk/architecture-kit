import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  appendRecord,
  commonDirOf,
  formatRecord,
  lastTaskDispatchOn,
  latestVerdictFor,
  latestVerdictOn,
  ledgerFileOf,
  readLedger,
  shaMatches,
} from "./ledger.mjs";

const QC = fileURLToPath(new URL("./qc.mjs", import.meta.url));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

/** A primary checkout with one commit, and a linked worktree of it on feat/1-x. */
function repo(t) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-ledger-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const main = path.join(base, "main");
  git(base, "init", "-q", "-b", "main", main);
  for (const [key, value] of [["user.name", "qc"], ["user.email", "qc@example.com"], ["commit.gpgsign", "false"]]) {
    git(main, "config", key, value);
  }
  writeFileSync(path.join(main, "a.txt"), "a\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  const linked = path.join(base, "linked");
  git(main, "worktree", "add", "-q", "-b", "feat/1-x", linked);
  return { base, main, linked };
}

test("a linked worktree and its primary checkout share one ledger", (t) => {
  const { main, linked } = repo(t);
  assert.equal(realpathSync.native(commonDirOf(linked)), realpathSync.native(path.join(main, ".git")));
  assert.equal(ledgerFileOf(main), path.join(main, ".git", "qc", "ledger.jsonl"));
  const commonOf = (root) => realpathSync.native(path.dirname(path.dirname(ledgerFileOf(root))));
  assert.equal(commonOf(linked), commonOf(main));
});

test("a folder with no .git has no ledger", (t) => {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-ledger-none-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  assert.equal(commonDirOf(base), null);
  assert.equal(ledgerFileOf(base), null);
});

test("records append as JSON lines with their time, and a torn line is skipped", (t) => {
  const { main } = repo(t);
  const file = ledgerFileOf(main);
  assert.deepEqual(readLedger(file), []);
  appendRecord(file, { type: "dispatch", agentType: "sdd-implementer" }, new Date("2026-01-01T00:00:00Z"));
  appendFileSync(file, '{"type":"verdict","kind":\n');
  appendRecord(file, { type: "stop", agentType: "sdd-implementer", agentId: "a1" }, new Date("2026-01-01T00:01:00Z"));
  assert.deepEqual(
    readLedger(file).map((record) => [record.type, record.at]),
    [
      ["dispatch", "2026-01-01T00:00:00.000Z"],
      ["stop", "2026-01-01T00:01:00.000Z"],
    ],
  );
});

test("an unknown record type is refused, so no reader meets a shape it does not know", (t) => {
  const { main } = repo(t);
  assert.throws(() => appendRecord(ledgerFileOf(main), { type: "note" }), /unknown record type "note"/);
});

test("two shas match when the shorter, of seven hex digits or more, starts the longer", () => {
  const full = "0123456789abcdef0123456789abcdef01234567";
  assert.ok(shaMatches("0123456", full));
  assert.ok(shaMatches(full.toUpperCase(), full));
  assert.ok(!shaMatches("012345", full));
  assert.ok(!shaMatches("0123457", full));
  assert.ok(!shaMatches("zzzzzzz", "zzzzzzzz"));
  assert.ok(!shaMatches(undefined, full));
});

test("the queries find the newest record of each kind", () => {
  const records = [
    { type: "verdict", kind: "task", verdict: "CHANGES_REQUIRED", sha: "aaaaaaa1", branch: "feat/1-x" },
    { type: "dispatch", task: true, branch: "feat/1-x", head: "h0" },
    { type: "verdict", kind: "task", verdict: "APPROVED", sha: "aaaaaaa1", branch: "feat/1-x" },
    { type: "verdict", kind: "branch", verdict: "APPROVED", sha: "bbbbbbb2", branch: "feat/2-y" },
    { type: "dispatch", task: false, branch: null, head: null },
  ];
  assert.equal(latestVerdictFor(records, "aaaaaaa", ["task"]).verdict, "APPROVED");
  assert.equal(latestVerdictFor(records, "aaaaaaa", ["branch"]), null);
  assert.equal(latestVerdictOn(records, "feat/2-y").kind, "branch");
  assert.equal(latestVerdictOn(records, "feat/3-z"), null);
  assert.equal(lastTaskDispatchOn(records, "feat/1-x").head, "h0");
  assert.equal(lastTaskDispatchOn(records, "feat/2-y"), null);
});

test("qc ledger prints one line per record, and a branch keeps only its own", (t) => {
  const { main } = repo(t);
  const empty = spawnSync(process.execPath, [QC, "ledger"], { cwd: main, encoding: "utf8" });
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /is empty/);
  const file = ledgerFileOf(main);
  appendRecord(file, { type: "verdict", kind: "task", verdict: "APPROVED", sha: "0123456789abcdef", branch: "feat/1-x", agentId: "r1" });
  appendRecord(file, { type: "verdict", kind: "branch", verdict: "CHANGES_REQUIRED", sha: "fedcba9876543210", branch: "feat/2-y", agentId: "r2" });
  const all = spawnSync(process.execPath, [QC, "ledger"], { cwd: main, encoding: "utf8" });
  assert.equal(all.status, 0, all.stderr);
  assert.equal(all.stdout.trim().split(/\r?\n/).length, 2);
  const one = spawnSync(process.execPath, [QC, "ledger", "feat/2-y"], { cwd: main, encoding: "utf8" });
  assert.match(one.stdout, /verdict\s+branch CHANGES_REQUIRED fedcba9 feat\/2-y/);
  assert.doesNotMatch(one.stdout, /feat\/1-x/);
});

test("an append after a torn last line keeps the new record whole", (t) => {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-ledger-torn-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const file = path.join(base, "ledger.jsonl");
  appendRecord(file, { type: "stop", role: "implementer" });
  appendFileSync(file, '{"type":"stop","role":"tor');
  appendRecord(file, { type: "verdict", verdict: "APPROVED" });
  assert.deepEqual(readLedger(file).map((record) => record.type), ["stop", "verdict"]);
  appendRecord(file, { type: "stop", role: "task" });
  assert.equal(readLedger(file).length, 3, "a file that ends in a newline gets no blank line");
});

test("a dispatch that passed on a CI failure shows the sha and the reason in the ledger line", () => {
  const line = formatRecord({
    at: "t",
    type: "dispatch",
    agentType: "sdd-implementer",
    task: true,
    branch: "feat/1-x",
    head: "abcdef1234",
    ciPass: { sha: "1234567890abcdef", reason: "CI on 1234567: build ended failure" },
  });
  assert.match(line, /CI-PASS: 1234567 CI on 1234567: build ended failure/);
});

const cost = (agentId, role, branch, input, output, toolCalls, extra = {}) => ({
  type: "cost",
  session: "s",
  agentId,
  agentType: `sdd-${role}`,
  role,
  model: "m",
  input,
  output,
  cacheRead: input * 10,
  cacheCreation: input,
  toolCalls,
  branch,
  head: null,
  ...extra,
});

test("qc ledger --cost totals tokens and tool calls per branch and per role, with a grand total", (t) => {
  const { main } = repo(t);
  const file = ledgerFileOf(main);
  appendRecord(file, cost("a1", "implementer", "feat/1-x", 10, 100, 5));
  appendRecord(file, cost("a2", "implementer", "feat/1-x", 20, 200, 7));
  appendRecord(file, cost("a3", "reviewer", "feat/1-x", 1, 2, 3));
  appendRecord(file, cost("a4", "planner", null, 4, 5, 6));
  // A resumed agent stops again with its whole transcript, so only its newest record counts.
  appendRecord(file, cost("a1", "implementer", "feat/1-x", 15, 150, 9));
  const all = spawnSync(process.execPath, [QC, "ledger", "--cost"], { cwd: main, encoding: "utf8" });
  assert.equal(all.status, 0, all.stderr);
  const lines = all.stdout.trim().split(/\r?\n/);
  assert.match(lines.find((line) => /^feat\/1-x/.test(line)), /agents 3 {2}in 36 {2}out 352 {2}cache-read 360 {2}cache-write 36 {2}tools 19/);
  assert.match(lines.find((line) => /^\s+implementer/.test(line)), /agents 2 {2}in 35 {2}out 350/);
  assert.match(lines.find((line) => /^\s+reviewer/.test(line)), /agents 1 {2}in 1 /);
  assert.match(lines.find((line) => /^\(no branch\)/.test(line)), /agents 1 {2}in 4 /);
  assert.match(lines.at(-1), /^total .*agents 4 {2}in 40 {2}out 357 .*tools 25/);
  const one = spawnSync(process.execPath, [QC, "ledger", "--cost", "feat/1-x"], { cwd: main, encoding: "utf8" });
  assert.match(one.stdout, /total .*agents 3 /);
  assert.doesNotMatch(one.stdout, /no branch/);
  const none = spawnSync(process.execPath, [QC, "ledger", "--cost", "feat/none"], { cwd: main, encoding: "utf8" });
  assert.match(none.stdout, /No cost record .* names feat\/none/);
});

test("a cost record prints as one line in the plain ledger listing", () => {
  const line = formatRecord({ ...cost("a1", "implementer", "feat/1-x", 10, 100, 5), at: "2026-10-09T10:00:00.000Z" });
  assert.match(line, /^2026-10-09T10:00:00.000Z {2}cost {10}implementer sdd-implementer a1 feat\/1-x in 10 out 100 .* tools 5$/);
});
