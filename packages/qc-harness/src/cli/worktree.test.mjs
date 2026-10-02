import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "../config.mjs";
import { runWorktree } from "./worktree.mjs";

const QC = fileURLToPath(new URL("./qc.mjs", import.meta.url));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const qc = (cwd, ...args) => spawnSync(process.execPath, [QC, "worktree", ...args], { cwd, encoding: "utf8" });
const lastLine = (out) => out.trim().split(/\r?\n/).at(-1);

// One comparable spelling of a path: real, absolute, and case-folded where the file system folds case.
const samePath = (p) => {
  const resolved = existsSync(p) ? realpathSync.native(p) : path.resolve(p);
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
};
// The worktree paths git registers. A test compares whole paths, never a substring of the list:
// the random temp directory name can contain any name a test gives its worktree.
const listedWorktrees = (cwd) =>
  git(cwd, "worktree", "list", "--porcelain")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => samePath(line.slice("worktree ".length)));

// The install writes only what git ignores, as pnpm does, so a fresh worktree stays clean.
const INSTALL = `node -e "require('fs').mkdirSync('node_modules',{recursive:true})"`;

/** A main checkout at <top>/main with a pushed main branch. `worktree` and `ignore` add to its config and its .gitignore. */
function fixture({ worktree = {}, ignore = "" } = {}) {
  const top = mkdtempSync(path.join(tmpdir(), "qc-wt-"));
  const origin = path.join(top, "origin.git");
  const main = path.join(top, "main");
  mkdirSync(main);
  git(top, "init", "-q", "--bare", "-b", "main", origin);
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.name", "qc");
  git(main, "config", "user.email", "qc@example.com");
  git(main, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(main, ".gitignore"), `node_modules/\n${ignore}`);
  writeFileSync(path.join(main, "qc.config.json"), JSON.stringify({ worktree: { install: INSTALL, ...worktree } }));
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

test("add makes a worktree under .worktree/ in the main checkout and installs it; remove deletes it and its merged branch", () => {
  const { top, main } = fixture();
  const where = added(main, "wt-a", "feat/a");
  assert.equal(realpathSync.native(where), realpathSync.native(path.join(main, ".worktree", "wt-a")));
  assert.equal(git(main, "status", "--porcelain"), "", "the worktree folder must be ignored in the main checkout");
  assert.match(readFileSync(path.join(main, ".git", "info", "exclude"), "utf8"), /^\.worktree\/$/m);
  assert.ok(existsSync(path.join(where, "node_modules")), "the install command did not run in the worktree");
  assert.equal(git(where, "branch", "--show-current"), "feat/a");
  assert.equal(added(main, "wt-a", "feat/a"), where, "a second add must find the same worktree");
  const registered = samePath(where);
  assert.ok(listedWorktrees(main).includes(registered), "git does not list the added worktree");

  const removed = qc(main, "remove", "wt-a");
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(where), false);
  assert.equal(git(main, "branch", "--list", "feat/a"), "");
  assert.ok(!listedWorktrees(main).includes(registered), "git still lists the removed worktree");
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
  const registered = samePath(where);
  assert.ok(listedWorktrees(main).includes(registered), "git does not list the added worktree");

  const removed = qc(main, "remove", "wt-long");
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(where), false);
  assert.ok(!listedWorktrees(main).includes(registered), "git still lists the removed worktree");
  rmSync(top, { recursive: true, force: true });
});

test("add leaves info/exclude alone when the folder is already ignored, and worktree.dir moves the folder", () => {
  const { top, main } = fixture({ worktree: { dir: "trees" }, ignore: "trees/\n" });
  const exclude = path.join(main, ".git", "info", "exclude");
  const before = existsSync(exclude) ? readFileSync(exclude, "utf8") : null;
  const where = added(main, "wt-d", "feat/d");
  assert.equal(realpathSync.native(where), realpathSync.native(path.join(main, "trees", "wt-d")));
  assert.equal(existsSync(exclude) ? readFileSync(exclude, "utf8") : null, before);
  assert.equal(git(main, "status", "--porcelain"), "");
  rmSync(top, { recursive: true, force: true });
});

test("remove finds a worktree at the sibling path beside the main checkout", () => {
  const { top, main } = fixture();
  const legacy = path.join(top, "wt-old");
  git(main, "worktree", "add", "-q", "-b", "feat/old", legacy, "origin/main");
  const removed = qc(main, "remove", "wt-old");
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(legacy), false);
  assert.ok(!listedWorktrees(main).includes(samePath(legacy)), "git still lists the removed worktree");
  rmSync(top, { recursive: true, force: true });
});

const PR_LIST = ["pr", "list", "--head"];

/** A gh stand-in that answers `gh pr list --head` with `prs`, and logs each call. */
function fakeGh(prs) {
  const calls = [];
  return { calls, gh: (args) => (calls.push(args), args.slice(0, 3).join(" ") === PR_LIST.join(" ") ? JSON.stringify(prs) : null) };
}

/** A worktree whose one commit reached main as a squash, as `gh pr merge --squash` leaves it. */
function squashed(main, name, branch) {
  const where = added(main, name, branch);
  writeFileSync(path.join(where, "work.txt"), "done\n");
  git(where, "add", "work.txt");
  git(where, "commit", "-q", "-m", "work");
  git(where, "push", "-q", "-u", "origin", branch);
  writeFileSync(path.join(main, "work.txt"), "done\n");
  git(main, "add", "work.txt");
  git(main, "commit", "-q", "-m", "work (#7)");
  git(main, "push", "-q", "origin", "main");
  return { where, tip: git(main, "rev-parse", branch) };
}

const removeIn = (main, name, gh) => runWorktree(load(main), ["remove", name], { gh });

test("remove deletes a squash-merged branch whose upstream is gone, on a merged PR with the same head", async () => {
  const { top, main } = fixture();
  const { tip } = squashed(main, "wt-s", "feat/s");
  git(main, "push", "-q", "origin", "--delete", "feat/s");
  git(main, "fetch", "-q", "--prune");
  const { gh, calls } = fakeGh([{ number: 7, headRefOid: tip }]);
  assert.equal(await removeIn(main, "wt-s", gh), 0);
  assert.equal(git(main, "branch", "--list", "feat/s"), "");
  assert.deepEqual(calls[0], ["pr", "list", "--head", "feat/s", "--state", "merged", "--json", "number,headRefOid"]);
  rmSync(top, { recursive: true, force: true });
});

test("remove deletes the remote branch of a merged PR that gh pr merge could not delete", async () => {
  const { top, main } = fixture();
  const { tip } = squashed(main, "wt-r", "feat/r");
  assert.equal(await removeIn(main, "wt-r", fakeGh([{ number: 7, headRefOid: tip }]).gh), 0);
  assert.equal(git(main, "branch", "--list", "feat/r"), "");
  assert.equal(git(main, "ls-remote", "--heads", "origin", "feat/r"), "");
  rmSync(top, { recursive: true, force: true });
});

test("remove keeps a branch with unpushed commits when no merged PR has it as its head", async () => {
  const { top, main } = fixture();
  const where = added(main, "wt-k", "feat/k");
  writeFileSync(path.join(where, "work.txt"), "done\n");
  git(where, "add", "work.txt");
  git(where, "commit", "-q", "-m", "work");
  for (const answer of [[], null]) {
    if (!existsSync(where)) added(main, "wt-k", "feat/k");
    const gh = answer === null ? () => null : fakeGh(answer).gh;
    assert.equal(await removeIn(main, "wt-k", gh), 0);
    assert.notEqual(git(main, "branch", "--list", "feat/k"), "", `kept with gh answering ${JSON.stringify(answer)}`);
  }
  rmSync(top, { recursive: true, force: true });
});

test("remove keeps a branch whose tip moved past the head of its merged PR", async () => {
  const { top, main } = fixture();
  const { where, tip } = squashed(main, "wt-m", "feat/m");
  writeFileSync(path.join(where, "more.txt"), "later\n");
  git(where, "add", "more.txt");
  git(where, "commit", "-q", "-m", "more");
  git(main, "push", "-q", "origin", "--delete", "feat/m");
  git(main, "fetch", "-q", "--prune");
  assert.equal(await removeIn(main, "wt-m", fakeGh([{ number: 7, headRefOid: tip }]).gh), 0);
  assert.notEqual(git(main, "branch", "--list", "feat/m"), "");
  rmSync(top, { recursive: true, force: true });
});
