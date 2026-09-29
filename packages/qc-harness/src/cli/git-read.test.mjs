import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { branchAt, branchesAt, commitOf, gitOut, linkedWorktrees, pathKey } from "./git-read.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

function repo(t) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-git-read-")));
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
