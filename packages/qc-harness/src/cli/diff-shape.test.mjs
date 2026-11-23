import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkDiffShape } from "./diff-shape.mjs";

function fixture(t) {
  const worktree = mkdtempSync(path.join(os.tmpdir(), "qc-diff-shape-"));
  t.after(() => rmSync(worktree, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const git = (...args) => execFileSync("git", ["-c", "user.name=Shape Test", "-c", "user.email=shape@example.test", ...args], { cwd: worktree, encoding: "utf8" }).trim();
  git("init", "-q");
  const write = (name, text) => { mkdirSync(path.dirname(path.join(worktree, name)), { recursive: true }); writeFileSync(path.join(worktree, name), text); };
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
  return { worktree, git, write, commit, check: (base, paths, extra = {}) => checkDiffShape({ worktree, base, paths, design: "", maxDiffLines: 400, ...extra }).problems };
}

test("diff shape: file outside Paths → one problem naming the file", (t) => {
  const f = fixture(t); f.write("owned/a.mjs", "before\n"); const base = f.commit();
  f.write("outside.mjs", "after\n");
  const problems = f.check(base, ["owned/**"]);
  assert.equal(problems.length, 1); assert.match(problems[0], /outside\.mjs/);
});

test('diff shape: 401 changed lines → one problem with "split the issue"', (t) => {
  const f = fixture(t); f.write("a.mjs", "before\n"); const base = f.commit();
  f.write("a.mjs", "after\n".repeat(400));
  const problems = f.check(base, ["a.mjs"]);
  assert.equal(problems.length, 1); assert.match(problems[0], /split the issue/);
});

test("diff shape: Windows backslash path inside Paths → no problem", (t) => {
  const f = fixture(t); f.write("src/a.mjs", "before\n"); const base = f.commit(); f.write("src/a.mjs", "after\n");
  assert.deepEqual(f.check(base, ["src\\a.mjs"]), []);
});

test("scope covers committed, index, tracked and untracked files including an unborn HEAD", (t) => {
  const f = fixture(t); f.write("new.mjs", "new\n");
  assert.deepEqual(f.check(null, ["new.mjs"]), []);
  assert.equal(f.check(null, ["other.mjs"]).length, 1);
  const base = f.commit(); f.write("committed.mjs", "commit\n"); f.commit();
  f.write("staged.mjs", "stage\n"); f.git("add", "."); f.write("new.mjs", "edit\n"); f.write("untracked.mjs", "new\n");
  const problems = f.check(base, ["none/**"]);
  for (const name of ["committed", "staged", "new", "untracked"]) assert.ok(problems.some((p) => p.includes(`${name}.mjs`)));
});

test("rename and deletion check both names with Git quoted filenames", (t) => {
  const f = fixture(t); f.write('outside space/old "quote".mjs', "same\n"); const base = f.commit();
  mkdirSync(path.join(f.worktree, "owned")); f.git("mv", 'outside space/old "quote".mjs', "owned/new.mjs");
  assert.ok(f.check(base, ["owned/**"]).some((p) => p.includes('outside space/old "quote".mjs')));
  f.git("rm", "-f", "owned/new.mjs");
  assert.ok(f.check(base, ["owned/**"]).some((p) => p.includes('outside space/old "quote".mjs')));
});

test("directory and glob ownership use path boundaries", (t) => {
  const f = fixture(t); f.write("src/nested/test.mjs", "ok\n");
  assert.deepEqual(f.check(null, ["src/"]), []);
  assert.deepEqual(f.check(null, ["src/**/*.mjs"]), []);
  assert.equal(f.check(null, ["sr"]).length, 1);
});

test("dependency additions require exact Design names, including aliases and devDependencies", (t) => {
  const f = fixture(t);
  f.write("package.json", JSON.stringify({ dependencies: { existing: "1" } })); const base = f.commit();
  f.write("package.json", JSON.stringify({ dependencies: { existing: "2", added: "npm:actual@1" }, devDependencies: { tool: "1" } }));
  assert.equal(f.check(base, ["package.json"]).length, 2);
  assert.equal(f.check(base, ["package.json"], { design: "Use added-extra and toolbox" }).length, 2);
  assert.deepEqual(f.check(base, ["package.json"], { design: "Dependencies: `added` (npm:actual@1), tool" }), []);
});

test("dependency checks include staged manifests and reject malformed JSON", (t) => {
  const f = fixture(t); f.write("package.json", "{}\n"); const base = f.commit();
  f.write("package.json", '{"devDependencies":{"tool":"1"}}'); f.git("add", "."); f.write("package.json", "{}\n");
  assert.ok(f.check(base, ["package.json"]).some((p) => p.includes("tool")));
  f.write("package.json", "{bad");
  assert.ok(f.check(base, ["package.json"]).some((p) => /JSON|manifest/i.test(p)));
});

test("line limit counts untracked content, accepts 400 and honors configured maximum", (t) => {
  const f = fixture(t); f.write("a.mjs", "new\n".repeat(400));
  assert.deepEqual(f.check(null, ["a.mjs"]), []);
  assert.match(f.check(null, ["a.mjs"], { maxDiffLines: 399 })[0], /split the issue/);
});

test("reverted committed paths still belong to the immutable run boundary", (t) => {
  const f = fixture(t); f.write("owned.mjs", "ok\n"); const base = f.commit();
  f.write("outside.mjs", "new\n"); f.commit(); f.git("rm", "outside.mjs"); f.commit();
  assert.ok(f.check(base, ["owned.mjs"]).some((p) => p.includes("outside.mjs")));
});

test("staged deletion plus untracked replacement retains both line counts", (t) => {
  const f = fixture(t); f.write("a.mjs", "old\n".repeat(400)); const base = f.commit();
  f.git("rm", "a.mjs"); f.write("a.mjs", "new\n");
  const problems = f.check(base, ["a.mjs"]);
  assert.equal(problems.length, 1); assert.match(problems[0], /401.*split the issue/);
});
