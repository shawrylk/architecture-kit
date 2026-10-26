import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runBranch, syncBranch } from "./branch-sync.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const quiet = (lines) => (line) => lines.push(line);
const run = (command, cwd) => spawnSync(command, { cwd, shell: true, stdio: "pipe" }).status ?? 1;

function commitFile(dir, file, text) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", file);
}

function batch(t, generated = false) {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-branch-sync-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q", "-b", "main");
  for (const [key, value] of [["user.name", "qc"], ["user.email", "qc@example.com"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) git(dir, "config", key, value);
  commitFile(dir, "db/0001_init.sql", "select 1;\n");
  commitFile(dir, "gen.mjs", 'import { writeFileSync } from "node:fs";\nwriteFileSync("out.generated.txt", "regenerated");\n');
  commitFile(dir, "a.txt", "base\n");
  if (generated) commitFile(dir, "out.generated.txt", "base\n");
  git(dir, "switch", "-q", "-c", "feat/5-mine");
  commitFile(dir, "db/0002_mine.sql", "select 'mine';\n");
  git(dir, "switch", "-q", "main");
  commitFile(dir, "db/0002_theirs.sql", "select 'theirs';\n");
  git(dir, "switch", "-q", "feat/5-mine");
  return dir;
}

const config = (dir, command = "node gen.mjs") => ({
  root: dir,
  paths: { migrations: "db" },
  generated: { globs: ["**/*.generated.*"], command },
  worktree: { base: "main" },
  swarm: { isolation: { protectedBranches: ["main"] } },
});

test("sync merges the base, renumbers its own migrations, and commits generated files", async (t) => {
  const dir = batch(t);
  const said = [];
  assert.deepEqual(await syncBranch(config(dir), dir, { say: quiet(said), run }), { code: 0, changed: true, branch: "feat/5-mine" });
  assert.deepEqual(readdirSync(path.join(dir, "db")).sort(), ["0001_init.sql", "0002_theirs.sql", "0003_mine.sql"]);
  git(dir, "merge-base", "--is-ancestor", "main", "HEAD");
  assert.equal(git(dir, "status", "--porcelain"), "");
  assert.equal(readFileSync(path.join(dir, "out.generated.txt"), "utf8"), "regenerated");
  assert.ok(said.includes("rename db/0002_mine.sql -> 0003_mine.sql"));
  assert.match(git(dir, "log", "-1", "--format=%b"), /Refs #5/);
  const head = git(dir, "rev-parse", "HEAD");
  assert.deepEqual(await syncBranch(config(dir), dir, { say: quiet(said), run }), { code: 0, changed: false });
  assert.equal(git(dir, "rev-parse", "HEAD"), head);
  assert.ok(said.includes("OK  feat/5-mine already holds main"));
});

test("a source conflict leaves the merge in progress and reports recovery instructions", async (t) => {
  const dir = batch(t);
  commitFile(dir, "a.txt", "mine\n");
  git(dir, "switch", "-q", "main");
  commitFile(dir, "a.txt", "theirs\n");
  git(dir, "switch", "-q", "feat/5-mine");
  const said = [];
  assert.equal((await syncBranch(config(dir), dir, { say: quiet(said), run })).code, 1);
  assert.ok(existsSync(path.join(dir, ".git", "MERGE_HEAD")));
  assert.match(said.join("\n"), /a\.txt/);
  assert.match(said.join("\n"), /qc migrations renumber --onto main/);
});

test("a generated conflict is resolved and regenerated", async (t) => {
  const dir = batch(t, true);
  commitFile(dir, "out.generated.txt", "mine\n");
  git(dir, "switch", "-q", "main");
  commitFile(dir, "out.generated.txt", "theirs\n");
  git(dir, "switch", "-q", "feat/5-mine");
  assert.equal((await syncBranch(config(dir), dir, { say: quiet([]), run })).code, 0);
  assert.equal(readFileSync(path.join(dir, "out.generated.txt"), "utf8"), "regenerated");
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("sync refuses a protected branch", async (t) => {
  const dir = batch(t);
  git(dir, "switch", "-q", "main");
  await assert.rejects(() => syncBranch(config(dir), dir), /protected.*main|main.*protected/);
});

test("sync refuses a dirty tree", async (t) => {
  const dir = batch(t);
  writeFileSync(path.join(dir, "a.txt"), "dirty\n");
  await assert.rejects(() => syncBranch(config(dir), dir), /working tree.*changes|dirty/);
});

test("sync refuses a detached head", async (t) => {
  const dir = batch(t);
  git(dir, "checkout", "-q", "--detach");
  await assert.rejects(() => syncBranch(config(dir), dir), /detached/i);
});

test("sync refuses an unknown base", async (t) => {
  const dir = batch(t);
  await assert.rejects(() => syncBranch(config(dir), dir, { base: "missing-base" }), /missing-base/);
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("sync refuses a merge in progress", async (t) => {
  const dir = batch(t);
  git(dir, "merge", "--no-ff", "--no-commit", "main");
  await assert.rejects(() => syncBranch(config(dir), dir), /merge.*in progress/);
});

test("sync throws when the generator fails", async (t) => {
  const dir = batch(t);
  await assert.rejects(() => syncBranch(config(dir, 'node -e "process.exit(1)"'), dir, { say: quiet([]), run }), /generated\.command failed/);
});

test("branch sync pushes a changed branch through a gate slot in its worktree", async (t) => {
  const dir = batch(t);
  const said = [];
  const calls = [];
  const runSlot = (words, cwd) => { calls.push({ words, cwd }); return 0; };
  assert.equal(await runBranch(config(dir), ["sync", dir], { say: quiet(said), run, runSlot }), 0);
  assert.deepEqual(calls, [{ words: ["git", "push", "-u", "origin", "feat/5-mine"], cwd: dir }]);
  assert.ok(said.includes("push  feat/5-mine"));
});

test("branch sync with --no-push skips the gate slot", async (t) => {
  const dir = batch(t);
  const calls = [];
  const runSlot = (words, cwd) => { calls.push({ words, cwd }); return 0; };
  assert.equal(await runBranch(config(dir), ["sync", dir, "--no-push"], { say: quiet([]), run, runSlot }), 0);
  assert.deepEqual(calls, []);
  git(dir, "merge-base", "--is-ancestor", "main", "HEAD");
});

test("branch sync skips the gate slot for an up-to-date branch", async (t) => {
  const dir = batch(t);
  git(dir, "merge", "--no-edit", "main");
  const calls = [];
  const runSlot = (words, cwd) => { calls.push({ words, cwd }); return 0; };
  assert.equal(await runBranch(config(dir), ["sync", dir], { say: quiet([]), run, runSlot }), 0);
  assert.deepEqual(calls, []);
});

test("branch sync returns one after a conflict and skips the gate slot", async (t) => {
  const dir = batch(t);
  commitFile(dir, "a.txt", "mine\n");
  git(dir, "switch", "-q", "main");
  commitFile(dir, "a.txt", "theirs\n");
  git(dir, "switch", "-q", "feat/5-mine");
  const calls = [];
  const runSlot = (words, cwd) => { calls.push({ words, cwd }); return 0; };
  assert.equal(await runBranch(config(dir), ["sync", dir], { say: quiet([]), run, runSlot }), 1);
  assert.deepEqual(calls, []);
  assert.ok(existsSync(path.join(dir, ".git", "MERGE_HEAD")));
});

test("branch sync returns the gate slot's failure code", async (t) => {
  const dir = batch(t);
  const calls = [];
  const runSlot = (words, cwd) => { calls.push({ words, cwd }); return 7; };
  assert.equal(await runBranch(config(dir), ["sync", dir], { say: quiet([]), run, runSlot }), 7);
  assert.deepEqual(calls, [{ words: ["git", "push", "-u", "origin", "feat/5-mine"], cwd: dir }]);
});

for (const argv of [["sync"], ["sync", ".", "extra"], ["merge", "."], [], ["sync", ".", "--base"], ["sync", ".", "--unknown"]]) {
  test(`branch rejects invalid arguments ${JSON.stringify(argv)} with usage`, async () => {
    const said = [];
    const calls = [];
    const runSlot = (words, cwd) => { calls.push({ words, cwd }); return 0; };
    assert.equal(await runBranch(config("."), argv, { say: quiet(said), run, runSlot }), 2);
    assert.match(said.join("\n"), /qc branch sync <worktree> \[--base <ref>\] \[--no-push\]/);
    assert.deepEqual(calls, []);
  });
}

test("branch sync resolves its worktree against config.root and accepts --base", async (t) => {
  const dir = batch(t);
  const cfg = { ...config(dir), root: path.dirname(dir), worktree: { base: "missing-base" } };
  const calls = [];
  const runSlot = (words, cwd) => { calls.push({ words, cwd }); return 0; };
  assert.equal(await runBranch(cfg, ["sync", path.basename(dir), "--base", "main"], { say: quiet([]), run, runSlot }), 0);
  assert.deepEqual(calls, [{ words: ["git", "push", "-u", "origin", "feat/5-mine"], cwd: dir }]);
});

test("branch sync prints a refusal and skips the gate slot", async (t) => {
  const dir = batch(t);
  writeFileSync(path.join(dir, "a.txt"), "dirty\n");
  const said = [];
  const calls = [];
  const runSlot = (words, cwd) => { calls.push({ words, cwd }); return 0; };
  assert.equal(await runBranch(config(dir), ["sync", dir], { say: quiet(said), run, runSlot }), 1);
  assert.match(said.join("\n"), /^qc branch: .*working tree has changes/);
  assert.deepEqual(calls, []);
});
