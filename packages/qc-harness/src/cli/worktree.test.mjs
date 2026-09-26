import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const QC = fileURLToPath(new URL("./qc.mjs", import.meta.url));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const qc = (cwd, ...args) => spawnSync(process.execPath, [QC, "worktree", ...args], { cwd, encoding: "utf8" });
const lastLine = (out) => out.trim().split(/\r?\n/).at(-1);

// The install writes only what git ignores, as pnpm does, so a fresh worktree stays clean.
const INSTALL = `node -e "require('fs').mkdirSync('node_modules',{recursive:true})"`;

/** A main checkout at <top>/main with a pushed main branch, so worktrees land inside <top>. */
function fixture() {
  const top = mkdtempSync(path.join(tmpdir(), "qc-wt-"));
  const origin = path.join(top, "origin.git");
  const main = path.join(top, "main");
  mkdirSync(main);
  git(top, "init", "-q", "--bare", "-b", "main", origin);
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.name", "qc");
  git(main, "config", "user.email", "qc@example.com");
  git(main, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(main, ".gitignore"), "node_modules/\n");
  writeFileSync(path.join(main, "qc.config.json"), JSON.stringify({ worktree: { install: INSTALL } }));
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  git(main, "remote", "add", "origin", origin);
  git(main, "push", "-q", "-u", "origin", "main");
  return { top, main };
}

function added(main, name, branch) {
  const result = qc(main, "add", name, branch);
  assert.equal(result.status, 0, result.stderr);
  return lastLine(result.stdout);
}

test("add makes a worktree beside the main checkout and installs it; remove deletes it and its merged branch", () => {
  const { top, main } = fixture();
  const where = added(main, "wt-a", "feat/a");
  assert.equal(realpathSync.native(where), realpathSync.native(path.join(top, "wt-a")));
  assert.ok(existsSync(path.join(where, "node_modules")), "the install command did not run in the worktree");
  assert.equal(git(where, "branch", "--show-current"), "feat/a");
  assert.equal(added(main, "wt-a", "feat/a"), where, "a second add must find the same worktree");

  const removed = qc(main, "remove", "wt-a");
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(where), false);
  assert.equal(git(main, "branch", "--list", "feat/a"), "");
  assert.doesNotMatch(git(main, "worktree", "list"), /wt-a/);
  const again = qc(main, "remove", "wt-a");
  assert.equal(again.status, 0, again.stderr);
  rmSync(top, { recursive: true, force: true });
});

test("remove refuses a tree with uncommitted changes and leaves it in place", () => {
  const { top, main } = fixture();
  const where = added(main, "wt-b", "feat/b");
  writeFileSync(path.join(where, "draft.txt"), "unsaved\n");
  const refused = qc(main, "remove", "wt-b");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /draft\.txt/);
  assert.ok(existsSync(path.join(where, "draft.txt")));
  rmSync(top, { recursive: true, force: true });
});

test("remove keeps a branch with an unpushed commit, and deletes it once pushed", () => {
  const { top, main } = fixture();
  let where = added(main, "wt-c", "feat/c");
  writeFileSync(path.join(where, "work.txt"), "done\n");
  git(where, "add", "work.txt");
  git(where, "commit", "-q", "-m", "work");
  const kept = qc(main, "remove", "wt-c");
  assert.equal(kept.status, 0, kept.stderr);
  assert.equal(existsSync(where), false);
  assert.match(kept.stdout, /kept branch feat\/c/);
  assert.notEqual(git(main, "branch", "--list", "feat/c"), "");

  where = added(main, "wt-c", "feat/c");
  assert.ok(existsSync(path.join(where, "work.txt")), "the existing branch must be checked out, not recreated");
  git(where, "push", "-q", "-u", "origin", "feat/c");
  const deleted = qc(main, "remove", "wt-c");
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.equal(git(main, "branch", "--list", "feat/c"), "");
  rmSync(top, { recursive: true, force: true });
});

// Windows refuses a path past 260 characters to most tools, `git worktree remove` among them.
// Every OS runs this; the windows-latest job is the proof.
test("remove deletes a worktree that holds a path longer than 260 characters", () => {
  const { top, main } = fixture();
  const where = added(main, "wt-long", "feat/long");
  const segments = Array.from({ length: 6 }, (_, i) => `${"segment".repeat(7)}-${i}`);
  const deep = path.join(where, "node_modules", ...segments);
  mkdirSync(deep, { recursive: true });
  writeFileSync(path.join(deep, "index.js"), "module.exports = {};\n");
  assert.ok(path.join(deep, "index.js").length > 260, `the fixture path is only ${path.join(deep, "index.js").length} characters`);
  assert.ok(existsSync(path.join(deep, "index.js")));

  const removed = qc(main, "remove", "wt-long");
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(where), false);
  assert.doesNotMatch(git(main, "worktree", "list"), /wt-long/);
  rmSync(top, { recursive: true, force: true });
});
