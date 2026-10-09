import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { directDefaults } from "../config.mjs";
import { directSettings, editLane, lineCount, mergeLane, pendingLines } from "./direct-lane.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const BASE = "origin/main";
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + "\n";

/** A repository with `origin/main` at its first commit and a branch `feat/1-x` checked out. */
function repo(t) {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-direct-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  for (const [key, value] of [["user.name", "qc"], ["user.email", "qc@example.com"], ["commit.gpgsign", "false"]]) git(root, "config", key, value);
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "a.ts"), lines(10));
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(root, "switch", "-q", "-c", "feat/1-x");
  return root;
}

const commit = (root, file, text) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", `change ${file}`);
  return git(root, "rev-parse", "HEAD");
};

const edit = (root, rel, input, direct = directDefaults) =>
  editLane({ root, base: BASE, direct, protectedBranches: ["main"], rel, toolName: "Edit", input });

test("the settings fill their defaults, accept false, and name a wrong key", () => {
  assert.deepEqual(directSettings({}), directDefaults);
  assert.equal(directSettings({ direct: false }), null);
  assert.equal(directSettings({ direct: { maxLines: 5 } }).maxLines, 5);
  assert.throws(() => directSettings({ direct: { maxLines: 0 } }), /swarm\.direct\.maxLines/);
  assert.throws(() => directSettings({ direct: { excludes: "a" } }), /swarm\.direct\.excludes/);
  assert.throws(() => directSettings({ direct: { lines: 5 } }), /swarm\.direct\.lines in qc\.config\.json is not a direct lane setting/);
  assert.throws(() => directSettings({ direct: true }), /must be an object or false/);
});

test("lines count as git counts them, and an edit counts both its old and its new text", () => {
  assert.equal(lineCount(""), 0);
  assert.equal(lineCount("a"), 1);
  assert.equal(lineCount("a\nb\n"), 2);
  assert.equal(pendingLines("Edit", { old_string: "a", new_string: "b" }), 2);
  assert.equal(pendingLines("MultiEdit", { edits: [{ old_string: "a", new_string: "b\nc" }, { old_string: "d", new_string: "" }] }), 4);
  assert.equal(pendingLines("Write", { content: lines(7) }), 7);
  assert.equal(pendingLines("NotebookEdit", { new_source: "x\ny" }), 2);
});

test("a small edit on a branch fits, and the branch diff counts toward the limit", (t) => {
  const root = repo(t);
  const fit = edit(root, "src/a.ts", { old_string: "line 1", new_string: "line one" });
  assert.equal(fit.problem, null);
  assert.deepEqual(fit.size, { files: 1, lines: 2 });
  commit(root, "src/a.ts", lines(10).replace("line 1\n", "x\n".repeat(10)));
  assert.deepEqual(edit(root, "src/a.ts", { old_string: "line 2", new_string: "y" }).size, { files: 1, lines: 13 });
  commit(root, "src/a.ts", lines(10).replace("line 1\n", "x\n".repeat(19)));
  assert.match(edit(root, "src/a.ts", { old_string: "line 2", new_string: "y" }).problem, /changes 22 of 20 lines in 1 of 2 files/);
});

test("too many lines, too many files, or an excluded path leaves the lane", (t) => {
  const root = repo(t);
  assert.match(edit(root, "src/a.ts", { old_string: lines(11), new_string: lines(11) }).problem, /22 of 20 lines/);
  writeFileSync(path.join(root, "src", "b.ts"), "b\n");
  writeFileSync(path.join(root, "src", "c.ts"), "c\n");
  assert.match(edit(root, "src/a.ts", { old_string: "a", new_string: "b" }).problem, /in 3 of 2 files/);
  rmSync(path.join(root, "src", "c.ts"));
  assert.match(edit(root, "schemas/api.yaml", { old_string: "a", new_string: "b" }).problem, /schemas\/api\.yaml matches swarm\.direct\.excludes/);
});

test("an untracked file counts its lines", (t) => {
  const root = repo(t);
  writeFileSync(path.join(root, "src", "new.ts"), lines(19));
  assert.match(edit(root, "src/a.ts", { old_string: "a", new_string: "b" }).problem, /21 of 20 lines in 2 of 2 files/);
});

test("a protected branch, a detached head, or a missing base ref leaves the lane", (t) => {
  const root = repo(t);
  git(root, "switch", "-q", "main");
  assert.match(edit(root, "src/a.ts", { old_string: "a", new_string: "b" }).problem, /main is a protected branch/);
  git(root, "switch", "-q", "--detach");
  assert.match(edit(root, "src/a.ts", { old_string: "a", new_string: "b" }).problem, /detached head/);
  git(root, "switch", "-q", "feat/1-x");
  git(root, "update-ref", "-d", "refs/remotes/origin/main");
  assert.match(edit(root, "src/a.ts", { old_string: "a", new_string: "b" }).problem, /cannot diff the branch against origin\/main/);
});

test("a small head with no review merges through the lane", (t) => {
  const root = repo(t);
  const sha = commit(root, "src/a.ts", lines(10).replace("line 3", "line three"));
  const fit = mergeLane({ root, base: BASE, direct: directDefaults, sha, records: [] });
  assert.equal(fit.problem, null);
  assert.deepEqual(fit.size, { files: 1, lines: 2 });
});

test("a review that is not APPROVED, an implementer commit, or a large head keeps the lane shut", (t) => {
  const root = repo(t);
  const sha = commit(root, "src/a.ts", lines(10).replace("line 3", "line three"));
  const changes = [{ type: "verdict", kind: "task", verdict: "CHANGES_REQUIRED", sha }];
  assert.match(mergeLane({ root, base: BASE, direct: directDefaults, sha, records: changes }).problem, /latest review on the branch, of .*, is CHANGES_REQUIRED/);
  const stop = [{ type: "stop", role: "implementer", head: sha, branch: "feat/1-x" }];
  assert.match(mergeLane({ root, base: BASE, direct: directDefaults, sha, records: stop }).problem, /an implementer committed on the branch/);
  const big = commit(root, "src/b.ts", lines(30));
  assert.match(mergeLane({ root, base: BASE, direct: directDefaults, sha: big, records: [] }).problem, /32 of 20 lines/);
  assert.match(mergeLane({ root, base: "origin/none", direct: directDefaults, sha, records: [] }).problem, /merge base of origin\/none/);
});

test("a head that touches a review path needs one APPROVED review of either kind", (t) => {
  const root = repo(t);
  const sha = commit(root, "src/a.ts", lines(10).replace("line 3", "line three"));
  const direct = { ...directDefaults, reviewPaths: ["src/**"] };
  assert.match(mergeLane({ root, base: BASE, direct, sha, records: [] }).problem, /src\/a\.ts matches swarm\.direct\.reviewPaths/);
  const approved = [{ type: "verdict", kind: "task", verdict: "APPROVED", sha }];
  assert.equal(mergeLane({ root, base: BASE, direct, sha, records: approved }).problem, null);
});

test("a commit after a review that asked for changes stays out of the lane until a review approves it", (t) => {
  const root = repo(t);
  const first = commit(root, "src/a.ts", lines(10).replace("line 3", "line three"));
  const records = [{ type: "verdict", kind: "task", verdict: "CHANGES_REQUIRED", sha: first }];
  const second = commit(root, "src/a.ts", lines(10).replace("line 3", "line 3!"));
  assert.match(mergeLane({ root, base: BASE, direct: directDefaults, sha: second, records }).problem, /CHANGES_REQUIRED/);
  records.push({ type: "verdict", kind: "task", verdict: "APPROVED", sha: second });
  assert.equal(mergeLane({ root, base: BASE, direct: directDefaults, sha: second, records }).problem, null);
});

test("an amend after a review that asked for changes, or after an implementer commit, stays out of the lane", (t) => {
  const root = repo(t);
  const first = commit(root, "src/a.ts", lines(10).replace("line 3", "line three"));
  const verdicts = [{ type: "verdict", kind: "task", verdict: "CHANGES_REQUIRED", sha: first, branch: "feat/1-x" }];
  const stops = [{ type: "stop", role: "implementer", head: first, branch: "feat/1-x" }];
  writeFileSync(path.join(root, "src", "a.ts"), lines(10).replace("line 3", "line 3!"));
  git(root, "commit", "-q", "--amend", "-am", "amended");
  const amended = git(root, "rev-parse", "HEAD");
  assert.match(mergeLane({ root, base: BASE, direct: directDefaults, sha: amended, records: verdicts }).problem, /CHANGES_REQUIRED/);
  assert.match(mergeLane({ root, base: BASE, direct: directDefaults, sha: amended, records: stops }).problem, /an implementer committed/);
});

test("a head that no local branch points at stays out of the lane", (t) => {
  const root = repo(t);
  const sha = commit(root, "src/a.ts", lines(10).replace("line 3", "line three"));
  git(root, "reset", "-q", "--hard", "HEAD~1");
  assert.match(mergeLane({ root, base: BASE, direct: directDefaults, sha, records: [] }).problem, /no local branch points at/);
});

test("a binary file, a submodule, or an untracked binary has no size the lane can judge", (t) => {
  const root = repo(t);
  writeFileSync(path.join(root, "src", "lib.dll"), Buffer.from([0, 1, 2, 3]));
  assert.match(edit(root, "src/a.ts", { old_string: "a", new_string: "b" }).problem, /src\/lib\.dll is a binary file/);
  const binary = commit(root, "src/lib.dll", Buffer.from([0, 1, 2, 3]));
  assert.match(mergeLane({ root, base: BASE, direct: directDefaults, sha: binary, records: [] }).problem, /src\/lib\.dll is a binary file/);
  git(root, "reset", "-q", "--hard", "HEAD~1");
  git(root, "update-index", "--add", "--cacheinfo", `160000,${git(root, "rev-parse", "HEAD")},vendor/sub`);
  git(root, "commit", "-q", "-m", "submodule");
  assert.match(mergeLane({ root, base: BASE, direct: directDefaults, sha: git(root, "rev-parse", "HEAD"), records: [] }).problem, /vendor\/sub is a binary file, a large file, or a submodule/);
});

test("a lane that runs out of time closes", (t) => {
  const root = repo(t);
  const sha = commit(root, "src/a.ts", lines(10).replace("line 3", "line three"));
  assert.match(editLane({ root, base: BASE, direct: directDefaults, protectedBranches: [], rel: "src/a.ts", toolName: "Edit", input: {}, budgetMs: 0 }).problem, /budget of the lane/);
  assert.match(mergeLane({ root, base: BASE, direct: directDefaults, sha, records: [], budgetMs: 0 }).problem, /budget of the lane/);
});

test("a Write over a file counts the lines it replaces", (t) => {
  const root = repo(t);
  const write = editLane({ root, base: BASE, direct: directDefaults, protectedBranches: [], rel: "src/a.ts", toolName: "Write", input: { content: lines(11) } });
  assert.match(write.problem, /21 of 20 lines/);
});
