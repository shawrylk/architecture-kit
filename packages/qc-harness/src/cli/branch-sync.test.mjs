import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { runBranch, syncBranch } from "./branch-sync.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const quiet = (lines) => (line) => lines.push(line);
const run = (command, cwd) => spawnSync(command, { cwd, shell: true, stdio: "pipe" }).status ?? 1;

beforeEach((t) => {
  const previous = process.env.QC_GATE_SLOT_DIR;
  const directory = mkdtempSync(path.join(os.tmpdir(), "qc-branch-sync-slots-"));
  process.env.QC_GATE_SLOT_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.QC_GATE_SLOT_DIR;
    else process.env.QC_GATE_SLOT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
});

test("a pause refuses sync before branch changes or a push", async (t) => {
  const dir = batch(t);
  const head = git(dir, "rev-parse", "HEAD");
  mkdirSync(path.join(dir, ".git", "qc"), { recursive: true });
  writeFileSync(path.join(dir, ".git", "qc", "pause"), "operator investigation\n");
  const refusal = "An operator paused the kit: operator investigation. Wait for the operator to run `qc resume`.";
  await assert.rejects(() => syncBranch(config(dir), dir), { message: refusal });
  const lines = [];
  assert.equal(await runBranch(config(dir), ["sync", "."], {
    say: quiet(lines), runSlot: () => assert.fail("a paused branch must never push"),
  }), 1);
  assert.deepEqual(lines, [`qc branch: ${refusal}`]);
  assert.equal(git(dir, "rev-parse", "HEAD"), head);
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("each branch-sync test uses a private gate-slot folder", () => {
  const directory = process.env.QC_GATE_SLOT_DIR;
  assert.ok(directory);
  assert.match(path.basename(directory), /^qc-branch-sync-slots-/);
  assert.ok(existsSync(directory));
  assert.notEqual(directory, path.join(os.tmpdir(), "architecture-kit", "gate-slots"));
});

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
  git(dir, "branch", "published", "HEAD");
  git(dir, "branch", "--set-upstream-to=published");
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
  git(dir, "branch", "published", "HEAD");
  git(dir, "branch", "--set-upstream-to=published");
  const calls = [];
  const runSlot = (words, cwd) => { calls.push({ words, cwd }); return 0; };
  assert.equal(await runBranch(config(dir), ["sync", dir], { say: quiet([]), run, runSlot }), 0);
  assert.deepEqual(calls, []);
});

test("branch sync pushes a branch containing a semicolon as one argument", async (t) => {
  const dir = batch(t);
  const remote = `${dir}-remote.git`;
  t.after(() => rmSync(remote, { recursive: true, force: true }));
  git(dir, "init", "--bare", "-q", remote);
  git(dir, "remote", "add", "origin", remote);
  const branch = process.platform === "win32" ? "feat/5-mine;&ver" : "feat/5-mine;echo>injected";
  git(dir, "branch", "-m", branch);
  assert.equal(await runBranch(config(dir), ["sync", dir], { say: quiet([]), run }), 0);
  assert.equal(existsSync(path.join(dir, "injected")), false);
  assert.equal(git(remote, "rev-parse", `refs/heads/${branch}`), git(dir, "rev-parse", "HEAD"));
});

test("a resolved source conflict reruns the generator and pushes once", async (t) => {
  const dir = batch(t);
  commitFile(dir, "a.txt", "mine\n");
  git(dir, "switch", "-q", "main");
  commitFile(dir, "a.txt", "theirs\n");
  git(dir, "switch", "-q", "feat/5-mine");
  assert.equal((await syncBranch(config(dir), dir, { say: quiet([]), run })).code, 1);
  commitFile(dir, "a.txt", "resolved\n");
  const calls = [];
  let generated = 0;
  const runSlot = (words, cwd) => { calls.push({ words, cwd }); return 0; };
  assert.equal(await runBranch(config(dir), ["sync", dir], {
    say: quiet([]), runSlot, run: (command, cwd) => { generated += 1; return run(command, cwd); },
  }), 0);
  assert.equal(generated, 1);
  assert.equal(readFileSync(path.join(dir, "out.generated.txt"), "utf8"), "regenerated");
  assert.deepEqual(calls, [{ words: ["git", "push", "-u", "origin", "feat/5-mine"], cwd: dir }]);
});

test("sync holds gate slots for the merge commit, generator, and generated commit", async (t) => {
  const dir = batch(t);
  const calls = [];
  let held = false;
  const withSlot = async (words, cwd, action) => {
    calls.push({ words, cwd });
    held = true;
    try { return await action(); } finally { held = false; }
  };
  await syncBranch(config(dir), dir, {
    say: quiet([]), withSlot,
    run: (command, cwd) => { assert.equal(held, true); return run(command, cwd); },
  });
  assert.deepEqual(calls.map(({ words }) => words.slice(0, 3)), [
    ["git", "commit", "-q"], ["node gen.mjs"], ["git", "commit", "-q"],
  ]);
  assert.ok(calls.every(({ cwd }) => cwd === dir));
});

test("a branch ahead of its upstream retries generation and a failed push", async (t) => {
  const dir = batch(t);
  git(dir, "branch", "published", "HEAD");
  git(dir, "branch", "--set-upstream-to=published");
  let generated = 0;
  let pushed = 0;
  const deps = {
    say: quiet([]),
    run: (command, cwd) => { generated += 1; return generated === 1 ? 1 : run(command, cwd); },
    runSlot: () => { pushed += 1; return pushed === 1 ? 7 : 0; },
  };
  assert.equal(await runBranch(config(dir), ["sync", dir], deps), 1);
  assert.equal(pushed, 0);
  assert.equal(await runBranch(config(dir), ["sync", dir], deps), 7);
  assert.equal(await runBranch(config(dir), ["sync", dir], deps), 0);
  assert.equal(generated, 3);
  assert.equal(pushed, 2);
});

test("a generated conflict without a generator stays unresolved and lists the file", async (t) => {
  const dir = batch(t, true);
  commitFile(dir, "out.generated.txt", "mine\n");
  git(dir, "switch", "-q", "main");
  commitFile(dir, "out.generated.txt", "theirs\n");
  git(dir, "switch", "-q", "feat/5-mine");
  const said = [];
  assert.equal((await syncBranch(config(dir, null), dir, { say: quiet(said), run })).code, 1);
  assert.match(said.join("\n"), /generated\.command/);
  assert.ok(said.includes("  out.generated.txt"));
  assert.equal(git(dir, "diff", "--name-only", "--diff-filter=U"), "out.generated.txt");
  assert.ok(existsSync(path.join(dir, ".git", "MERGE_HEAD")));
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
