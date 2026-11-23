import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { mutants, runMutation } from "./mutate.mjs";

const cleanup = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
function fixture(t, { source = "export const answer = true;\n", testSource = "import './value.mjs';\n" } = {}) {
  const worktree = mkdtempSync(path.join(os.tmpdir(), "qc-mutate-test-"));
  t.after(() => rmSync(worktree, cleanup));
  const git = (...args) => execFileSync("git", args, { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(path.join(worktree, "value.mjs"), "export const answer = false;\n");
  writeFileSync(path.join(worktree, "value.test.mjs"), testSource);
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(path.join(worktree, "value.mjs"), source);
  return { worktree, base, command: [process.execPath, "--test"], git };
}

test('mutants of "a < b" holds "a >= b"', () => {
  assert.ok(mutants("a < b").includes("a >= b"));
});

test("a survivor appears when no test covers the line", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await runMutation(f), { survived: [{ file: "value.mjs", line: 1, mutant: "export const answer = false;" }], skippedLines: 0 });
});

test("no survivor when a test fails on the mutant", async (t) => {
  const f = fixture(t, { testSource: "import assert from 'node:assert/strict'; import { answer } from './value.mjs'; assert.equal(answer, true);\n" });
  assert.deepEqual(await runMutation(f), { survived: [], skippedLines: 0 });
  for (const locked of [false, true]) {
    const related = fixture(t, { testSource: "import assert from 'node:assert/strict'; import { answer } from './bridge.mjs'; assert.equal(answer, true);\n" });
    const testSource = readFileSync(path.join(related.worktree, "value.test.mjs"), "utf8");
    rmSync(path.join(related.worktree, "value.test.mjs"));
    const file = locked ? "locked.mjs" : "acceptance.test.mjs";
    writeFileSync(path.join(related.worktree, file), testSource);
    writeFileSync(path.join(related.worktree, "bridge.mjs"), "export { answer } from './value.mjs';\n");
    assert.deepEqual(await runMutation({ ...related, files: locked ? [file] : [] }), { survived: [], skippedLines: 0 });
  }
});

test("the run stops at budgetMs and reports how many lines it skipped", async (t) => {
  const pidFile = path.join(os.tmpdir(), `qc-mutation-child-${process.pid}-${Date.now()}`);
  t.after(() => rmSync(pidFile, cleanup));
  const f = fixture(t, { source: "export const answer = true;\nexport const extra = false;\n", testSource: `import { answer } from './value.mjs'; import { writeFileSync } from 'node:fs'; if (!answer) { writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000); }\n` });
  const started = Date.now();
  const result = await runMutation({ ...f, command: [process.execPath], budgetMs: 3000 });
  assert.ok(Date.now() - started < 7000);
  assert.deepEqual(result, { survived: [], skippedLines: 2 });
  assert.ok(existsSync(pidFile), "mutant child reached its blocking code");
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(f.git("worktree", "list", "--porcelain").split("worktree ").length, 2);
});

test("mutants preserve strings, comments and operator boundaries", () => {
  for (const [operator, complement] of [[">", "<="], ["<=", ">"], [">=", "<"], ["===", "!=="], ["!==", "==="]]) assert.ok(mutants(`a ${operator} b`).includes(`a ${complement} b`));
  assert.ok(mutants("if (ready && (a < b)) return true;").includes("if (!(ready && (a < b))) return true;"));
  assert.ok(mutants("return a + b;").includes("return undefined;"));
  for (const source of ['"true < false"', "'a >= b'", "`true < false`", "// return true;", "/* true < false */", "/true|false/", "a => b", "a << b", "a >> b"]) assert.deepEqual(mutants(source), [], source);
  assert.ok(mutants('const x = "true"; return false; // true').includes('const x = "true"; return true; // true'));
});

test("mutation caps changed JS and TS lines and preserves the issue checkout", async (t) => {
  const source = Array.from({ length: 12 }, (_, i) => `export const v${i} = true;`).join("\n") + "\n";
  const f = fixture(t, { source });
  writeFileSync(path.join(f.worktree, "extra.ts"), "/*\ntrue < false\n*/\nexport const extra = true;\n");
  writeFileSync(path.join(f.worktree, "ignored.py"), "return True\n");
  f.git("add", "value.mjs");
  const before = f.git("status", "--porcelain=v1");
  const result = await runMutation({ ...f, maxLines: 100 });
  assert.equal(result.survived.length, 10);
  assert.equal(result.skippedLines, 3);
  assert.equal(f.git("status", "--porcelain=v1"), before);
  assert.equal(readFileSync(path.join(f.worktree, "value.mjs"), "utf8"), source);
  assert.equal(f.git("worktree", "list", "--porcelain").split("worktree ").length, 2);
});

test("a failed baseline or missing tests produces one diagnostic and no coverage", async (t) => {
  for (const missing of [false, true]) {
    const f = fixture(t, { testSource: "process.exit(1);\n" });
    if (missing) rmSync(path.join(f.worktree, "value.test.mjs"));
    const diagnostics = [];
    assert.deepEqual(await runMutation({ ...f, say: (line) => diagnostics.push(line) }), { survived: [], skippedLines: 0 });
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], missing ? /no test file/i : /baseline.*fail/i);
    assert.match(diagnostics[0], /no mutation coverage/i);
  }
});
