import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const QC = fileURLToPath(new URL("./qc.mjs", import.meta.url));
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const HOLDER = "session-bbbb-0000-1111";

/** A primary checkout with the given isolation config, one linked worktree, and a folder in no checkout to run from. */
function leasedWorktree(isolation = { require: "worktree" }) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-lease-")));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
  const primary = path.join(base, "primary");
  const linked = path.join(base, "linked");
  const outside = path.join(base, "outside");
  mkdirSync(primary);
  mkdirSync(outside);
  git(primary, "init", "-q", "-b", "main");
  writeFileSync(path.join(primary, "qc.config.json"), JSON.stringify({ swarm: { isolation } }));
  git(primary, "add", ".");
  git(primary, "-c", "user.name=qc", "-c", "user.email=qc@example.com", "commit", "-q", "-m", "init");
  git(primary, "worktree", "add", "-q", linked, "-b", "feat/work-order");
  const leaseFile = path.join(realpathSync.native(git(linked, "rev-parse", "--absolute-git-dir").trim()), "qc-agent-lease.json");
  const writeLease = (ageMs, sessionId = HOLDER) => {
    const updatedAt = new Date(Date.now() - ageMs).toISOString();
    writeFileSync(leaseFile, JSON.stringify({ sessionId, branch: "feat/work-order", updatedAt }));
    return Date.parse(updatedAt);
  };
  // Run from a folder in no checkout, so the command can only find the worktree through its path argument.
  const qc = (...args) =>
    spawnSync(process.execPath, [QC, "lease", ...args], { cwd: outside, input: "", encoding: "utf8" });
  return { linked, outside, leaseFile, writeLease, qc, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const iso = (ms) => new Date(ms).toISOString();

test("status reports a fresh lease: its holder, branch, age, lapse time, and that it binds", (t) => {
  const ws = leasedWorktree();
  t.after(ws.cleanup);
  const written = ws.writeLease(30 * MINUTE + 10_000);
  const result = ws.qc("status", ws.linked);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`holder\\s+${HOLDER}`));
  assert.match(result.stdout, /branch\s+feat\/work-order/);
  assert.ok(result.stdout.includes(`${iso(written)}, 30m ago`), result.stdout);
  assert.ok(result.stdout.includes(`${iso(written + 8 * HOUR)}, in 7h 29m`), result.stdout);
  assert.match(result.stdout, /state\s+held/);
});

test("status reads leaseHours from the worktree's own config, and reports a lapsed lease as lapsed", (t) => {
  const ws = leasedWorktree({ require: "worktree", leaseHours: 1 });
  t.after(ws.cleanup);
  const written = ws.writeLease(2 * HOUR + 10_000);
  const result = ws.qc("status", ws.linked);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`${iso(written + HOUR)}, 1h 0m ago`), result.stdout);
  assert.match(result.stdout, /state\s+lapsed/);
});

test("status and release on a worktree with no lease both say so", (t) => {
  const ws = leasedWorktree();
  t.after(ws.cleanup);
  for (const args of [["status", ws.linked], ["release", ws.linked, "--force"]]) {
    const result = ws.qc(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no lease/);
  }
});

test("release without --force refuses a lease that another session holds", (t) => {
  const ws = leasedWorktree();
  t.after(ws.cleanup);
  ws.writeLease(5 * MINUTE);
  const result = ws.qc("release", ws.linked, "--session", "session-aaaa");
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(HOLDER), result.stderr);
  assert.equal(existsSync(ws.leaseFile), true, "a refused release removed the lease");
});

test("release with neither --session nor --force refuses, and names both", (t) => {
  const ws = leasedWorktree();
  t.after(ws.cleanup);
  ws.writeLease(5 * MINUTE);
  const result = ws.qc("release", ws.linked);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--session/);
  assert.match(result.stderr, /--force/);
  assert.equal(existsSync(ws.leaseFile), true);
});

test("release by the holder's own session removes the lease", (t) => {
  const ws = leasedWorktree();
  t.after(ws.cleanup);
  ws.writeLease(5 * MINUTE);
  const result = ws.qc("release", ws.linked, "--session", HOLDER);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(ws.leaseFile), false);
});

test("release --force removes another session's lease, and prints what it removed", (t) => {
  const ws = leasedWorktree();
  t.after(ws.cleanup);
  const written = ws.writeLease(5 * MINUTE);
  const result = ws.qc("release", ws.linked, "--force");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(ws.leaseFile), false);
  assert.ok(result.stdout.includes(HOLDER), result.stdout);
  assert.ok(result.stdout.includes("feat/work-order"), result.stdout);
  assert.ok(result.stdout.includes(iso(written)), result.stdout);
});

test("release reads no config, so a qc.config.json that does not parse cannot block it", (t) => {
  const ws = leasedWorktree();
  t.after(ws.cleanup);
  ws.writeLease(5 * MINUTE);
  for (const folder of [ws.outside, ws.linked]) writeFileSync(path.join(folder, "qc.config.json"), "{ not json");
  const result = ws.qc("release", ws.linked, "--force");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(ws.leaseFile), false);
});

test("the qc usage lists both lease commands", () => {
  const result = spawnSync(process.execPath, [QC, "help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /qc lease status \[path\]/);
  assert.match(result.stdout, /qc lease release \[path\]/);
});

test("a path in no git checkout is a named error, not a silent pass", (t) => {
  const ws = leasedWorktree();
  t.after(ws.cleanup);
  const result = ws.qc("status", ws.outside);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not inside a git checkout/);
});
