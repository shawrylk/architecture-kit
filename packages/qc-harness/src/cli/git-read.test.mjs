import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { branchAt, branchesAt, commitOf, gitOut, gitOutWithin, linkedWorktrees, pathKey } from "./git-read.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

// A timed-out git call can leave a child that holds the folder for a moment, so a removal retries.
function removeTree(dir) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 20) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

function repo(t) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-git-read-")));
  t.after(() => removeTree(base));
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
  return { main, linked, head: git(main, "rev-parse", "HEAD") };
}

test("commitOf resolves a short or upper-case sha, and refuses one the repository lacks", (t) => {
  const { main, head } = repo(t);
  assert.equal(commitOf(main, head.slice(0, 7)), head);
  assert.equal(commitOf(main, head.slice(0, 9).toUpperCase()), head);
  assert.equal(commitOf(main, "deadbee"), null);
  assert.equal(gitOut(main, "no-such-subcommand"), null);
});

test("branchAt names the branch, and a detached head has none", (t) => {
  const { main, linked } = repo(t);
  assert.equal(branchAt(linked), "feat/1-x");
  assert.equal(branchAt(main), "main");
  git(linked, "checkout", "-q", "--detach");
  assert.equal(branchAt(linked), null);
});

test("branchesAt lists every local branch whose head is the sha", (t) => {
  const { main, head } = repo(t);
  assert.deepEqual(branchesAt(main, head), ["feat/1-x", "main"]);
  assert.deepEqual(branchesAt(main, "0".repeat(40)), []);
});

test("linkedWorktrees leaves out the primary checkout and names each branch and head", (t) => {
  const { main, linked, head } = repo(t);
  const found = linkedWorktrees(main);
  assert.equal(found.length, 1);
  assert.equal(pathKey(found[0].path), pathKey(linked));
  assert.equal(found[0].branch, "feat/1-x");
  assert.equal(found[0].head, head);
});

test("pathKey spells one folder one way", (t) => {
  const { linked } = repo(t);
  assert.equal(pathKey(linked.replaceAll("\\", "/")), pathKey(linked));
  if (process.platform === "win32") assert.equal(pathKey(linked.toUpperCase()), pathKey(linked));
});

test("linkedWorktrees run from a linked worktree still leaves out the primary checkout", (t) => {
  const { main, linked } = repo(t);
  const found = linkedWorktrees(linked);
  assert.equal(found.length, 1);
  assert.equal(pathKey(found[0].path), pathKey(linked));
  assert.notEqual(pathKey(found[0].path), pathKey(main));
});

test("a git call that outlives its timeout answers null", (t) => {
  const { main } = repo(t);
  const slow = ["-c", 'alias.slow=!node -e "setTimeout(() => {}, 3000)"', "slow"];
  const started = Date.now();
  assert.equal(gitOutWithin(200, main, ...slow), null);
  assert.ok(Date.now() - started < 2500);
  assert.equal(gitOutWithin(10_000, main, "rev-parse", "--is-inside-work-tree"), "true");
});
