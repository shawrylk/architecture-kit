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
  {
    const f = fixture(t); f.write("a.mjs", "new\n".repeat(400));
    assert.deepEqual(f.check(null, ["a.mjs"]), []);
    assert.match(f.check(null, ["a.mjs"], { maxDiffLines: 399 })[0], /split the issue/);
  }
  {
    const f = fixture(t); f.write("a.mjs", "old\n".repeat(400)); const base = f.commit();
    f.git("rm", "a.mjs"); f.write("a.mjs", "new\n");
    const problems = f.check(base, ["a.mjs"]);
    assert.equal(problems.length, 1); assert.match(problems[0], /401.*split the issue/);
  }
});

function baseMergeFixture(t) {
  const f = fixture(t);
  f.write("package.json", "{}\n"); f.write("owned/a.mjs", "before\n"); const initial = f.commit();
  f.git("checkout", "-qb", "run");
  f.write("existing.mjs", "already on the run branch\n"); const base = f.commit();
  f.git("checkout", "-qb", "incoming", initial);
  f.write("base.mjs", "from base\n".repeat(500)); f.commit();
  f.write("package.json", '{"devDependencies":{"base-tool":"1"}}\n'); f.commit();
  f.git("checkout", "-q", "run");
  return { ...f, base, baseRef: "incoming" };
}

test("base merge adds 500 lines and a devDependency; three own lines stay within the shape", (t) => {
  for (const state of ["committed", "staged", "working"]) {
    const f = baseMergeFixture(t);
    f.write("owned/before.mjs", "own before merge\n"); f.commit();
    f.git("merge", "--no-edit", "incoming");
    f.write("package.json", '{"name":"own-change","devDependencies":{"base-tool":"1"}}\n');
    if (state === "committed") f.commit();
    else {
      f.git("add", ".");
      if (state === "working") f.git("reset", "--quiet");
    }
    const paths = ["owned/**", "package.json"];
    assert.deepEqual(f.check(f.base, paths, { baseRef: f.baseRef }), [], state);
    assert.ok(f.check(f.base, paths).some((problem) => /split the issue/.test(problem)));
    assert.deepEqual(f.check(f.base, paths, { baseRef: "missing-ref" }), f.check(f.base, paths));
  }
});

test("conflicted manifest keeps dependencies from both the frozen base and incoming base", (t) => {
  const f = fixture(t);
  f.write("package.json", "{}\n"); const initial = f.commit();
  f.git("checkout", "-qb", "run");
  f.write("package.json", '{"devDependencies":{"existing-tool":"1"}}\n'); const base = f.commit();
  f.git("checkout", "-qb", "incoming", initial);
  f.write("package.json", '{"devDependencies":{"base-tool":"1"}}\n'); f.commit();
  f.git("checkout", "-q", "run");
  assert.throws(() => f.git("merge", "--no-edit", "incoming"));
  f.write("package.json", '{"devDependencies":{"existing-tool":"1","base-tool":"1"}}\n'); f.commit();
  assert.deepEqual(f.check(base, ["package.json"], { baseRef: "incoming" }), []);
});

test("two base merges use separate boundaries and count only two owned lines", (t) => {
  for (const state of ["committed", "staged", "working"]) {
    const f = baseMergeFixture(t);
    f.git("merge", "--no-edit", "incoming");
    f.git("checkout", "-q", "incoming");
    f.write("next-base.mjs", "more from base\n".repeat(500)); f.commit();
    f.git("checkout", "-q", "run");
    f.git("merge", "--no-edit", "incoming");
    f.write("owned/after.mjs", "own first line\nown second line\n");
    if (state === "committed") f.commit();
    else if (state === "staged") f.git("add", ".");
    assert.deepEqual(f.check(f.base, ["owned/**"], { baseRef: f.baseRef, maxDiffLines: 2 }), [], state);
  }
});

test("base merge still refuses 401 own lines in Paths", (t) => {
  for (const state of ["committed", "staged", "working"]) {
    const f = baseMergeFixture(t);
    f.git("merge", "--no-edit", "incoming");
    f.write("owned/after.mjs", "own line\n".repeat(401));
    if (state === "committed") f.commit();
    else {
      f.git("add", ".");
      if (state === "working") f.git("reset", "--quiet");
    }
    assert.deepEqual(f.check(f.base, ["owned/**"], { baseRef: f.baseRef }), [
      "401 changed lines exceeds codex.maxDiffLines 400; split the issue",
    ], state);
  }
});

test("diff shape: Windows backslash path inside Paths → no problem", (t) => {
  const f = fixture(t); f.write("src/a.mjs", "before\n"); const base = f.commit(); f.write("src/a.mjs", "after\n");
  assert.deepEqual(f.check(base, ["src\\a.mjs"]), []);
  f.git("checkout", "--", "src/a.mjs");
  for (const name of ["src/fixtures/unit/a.mjs", "src/nested/fixtures/a.mjs", "src/fixtures/a.mjs", "src/nested/fixtures/unit/a.mjs"]) {
    f.write(name, "new\n");
  }
  assert.deepEqual(f.check(base, ["src/**/fixtures/**/*.mjs"]), []);
  {
    const f = fixture(t); f.write("src/nested/test.mjs", "ok\n");
    assert.deepEqual(f.check(null, ["src/"]), []);
    assert.deepEqual(f.check(null, ["src/**/*.mjs"]), []);
    assert.equal(f.check(null, ["sr"]).length, 1);
  }
});

test("scope covers committed, index, tracked and untracked files including an unborn HEAD", (t) => {
  const f = fixture(t); f.write("new.mjs", "new\n");
  assert.deepEqual(f.check(null, ["new.mjs"]), []);
  assert.equal(f.check(null, ["other.mjs"]).length, 1);
  const base = f.commit(); f.write("committed.mjs", "commit\n"); f.commit();
  f.write("staged.mjs", "stage\n"); f.git("add", "."); f.write("new.mjs", "edit\n"); f.write("untracked.mjs", "new\n");
  const problems = f.check(base, ["none/**"]);
  for (const name of ["committed", "staged", "new", "untracked"]) assert.ok(problems.some((p) => p.includes(`${name}.mjs`)));
  {
    const oldPath = process.platform === "win32" ? "outside space/old quote.mjs" : 'outside space/old "quote".mjs';
    const f = fixture(t); f.write(oldPath, "same\n"); const base = f.commit();
    mkdirSync(path.join(f.worktree, "owned")); f.git("mv", oldPath, "owned/new.mjs");
    assert.ok(f.check(base, ["owned/**"]).some((p) => p.includes(oldPath)));
    f.git("rm", "-f", "owned/new.mjs");
    assert.ok(f.check(base, ["owned/**"]).some((p) => p.includes(oldPath)));
  }
  {
    const f = fixture(t); f.write("owned.mjs", "ok\n"); const base = f.commit();
    f.write("outside.mjs", "new\n"); f.commit(); f.git("rm", "outside.mjs"); f.commit();
    assert.ok(f.check(base, ["owned.mjs"]).some((p) => p.includes("outside.mjs")));
  }
});

test("dependency additions require exact Design names, including aliases and devDependencies", (t) => {
  const prose = fixture(t); prose.write("package.json", "{}\n"); const proseBase = prose.commit();
  prose.write("package.json", JSON.stringify({ dependencies: { "new-library": "1" } }));
  assert.deepEqual(prose.check(proseBase, ["package.json"], { design: "Add new-library." }), []);
  const f = fixture(t);
  f.write("package.json", JSON.stringify({ dependencies: { existing: "1" } })); const base = f.commit();
  f.write("package.json", JSON.stringify({ dependencies: { existing: "2", added: "npm:actual@1" }, devDependencies: { tool: "1" } }));
  assert.equal(f.check(base, ["package.json"]).length, 2);
  assert.equal(f.check(base, ["package.json"], { design: "Use added-extra and toolbox" }).length, 2);
  assert.deepEqual(f.check(base, ["package.json"], { design: "Dependencies: `added` (npm:actual@1), tool" }), []);
  {
    const f = fixture(t); f.write("package.json", "{}\n"); const base = f.commit();
    f.write("package.json", '{"devDependencies":{"tool":"1"}}'); f.git("add", "."); f.write("package.json", "{}\n");
    assert.ok(f.check(base, ["package.json"]).some((p) => p.includes("tool")));
    f.write("package.json", "{bad");
    assert.ok(f.check(base, ["package.json"]).some((p) => /JSON|manifest/i.test(p)));
  }
});
