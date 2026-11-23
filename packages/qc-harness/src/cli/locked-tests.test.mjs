import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DONE_MARKER, runCodexImplement } from "./codex-implement.mjs";

const quiet = () => {};
const source = (n, pass = false) => `import test from 'node:test';\n${Array.from({ length: n }, (_, i) => `test('acceptance ${i}', () => { ${pass ? "" : "throw new Error('red');"} });`).join("\n")}\n`;

function fixture(t, role = "implement", config = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-locked-tests-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const worktree = path.join(root, "repo");
  mkdirSync(worktree);
  const git = (...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", ...args], { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-qb", "feature/acceptance");
  writeFileSync(path.join(worktree, "qc.config.json"), JSON.stringify({ check: { base: "base" }, ...config }));
  writeFileSync(path.join(worktree, "value.mjs"), "export const value = false;\n");
  git("add", "."); git("commit", "-qm", "base"); git("branch", "base");
  const base = git("rev-parse", "HEAD");
  const brief = path.join(root, "brief.md");
  const progress = path.join(root, "progress.md");
  writeFileSync(brief, "# Brief\nPaths: *.mjs, qc.config.json\n## Product decisions\n- Test the runner.\n## Task\n1. Run.\n## Design\nUse the existing dependencies.\n");
  const lock = path.join(worktree, ".git", "qc", "locked-tests", `${encodeURIComponent("feature/acceptance")}.json`);
  const file = path.join(worktree, "acceptance.test.mjs");
  const seal = () => {
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(lock, JSON.stringify({ "acceptance.test.mjs": createHash("sha256").update(readFileSync(file)).digest("hex") }));
  };
  const messages = [];
  const checks = [];
  const run = (change, extra = {}) => runCodexImplement(["--brief", brief, "--worktree", worktree, "--progress", progress, "--role", role], {
    say: (line) => messages.push(line), out: quiet,
    runCheck: async (command, cwd) => { checks.push({ command, cwd }); return 0; },
    run: async () => { await change?.(); writeFileSync(progress, DONE_MARKER); return { status: 0 }; }, ...extra,
  });
  return { root, worktree, git, base, progress, lock, file, seal, run, messages, checks };
}

test("nine new cases in a tests run → exit 4 naming the cap 8", async (t) => {
  for (const state of ["untracked", "staged", "committed"]) {
    const f = fixture(t, "tests");
    assert.equal(await f.run(() => {
      writeFileSync(f.file, source(9));
      if (state !== "untracked") f.git("add", ".");
      if (state === "committed") f.git("commit", "-qm", "acceptance");
    }), 4);
    assert.match(f.messages.join("\n"), /maxNewCases.*8/);
    assert.equal(existsSync(f.lock), false);
  }
  const f = fixture(t, "tests");
  assert.equal(await f.run(() => writeFileSync(f.file, source(8))), 0);
  const { addedTestCases, checkLockedTests } = await import("./locked-tests.mjs");
  assert.equal(addedTestCases(f.worktree, f.base).length, 8);
  assert.deepEqual(checkLockedTests(f.worktree), { problems: [] });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(f.lock))), ["acceptance.test.mjs"]);
  assert.equal(f.git("worktree", "list", "--porcelain").match(/^worktree /gm).length, 1);
  const counted = fixture(t, "tests");
  writeFileSync(counted.file, "// test('comment', () => {});\nconst text = \"test('string')\";\n  test.only('only', () => {});\nit.skip('skip', () => {});\nit('plain', () => {});\n");
  counted.git("add", ".");
  counted.git("commit", "-qm", "registrations");
  assert.deepEqual(addedTestCases(counted.worktree, counted.base).map((entry) => entry.name), ["only", "skip", "plain"]);
  assert.deepEqual(addedTestCases(counted.worktree, counted.git("rev-parse", "HEAD")), []);
  const option = fixture(t, "tests");
  assert.equal(await option.run(() => writeFileSync(path.join(option.worktree, "--acceptance.test.mjs"), source(1, true))), 4);
  assert.match(option.messages.join("\n"), /--acceptance.test.mjs.*acceptance 0/);
  assert.equal(existsSync(option.lock), false);
  const { lockTests } = await import("./locked-tests.mjs");
  const linked = path.join(counted.root, "linked");
  counted.git("worktree", "add", "-qb", "other/tests", linked);
  lockTests(linked, ["acceptance.test.mjs"]);
  assert.ok(existsSync(path.join(counted.worktree, ".git/qc/locked-tests/other%2Ftests.json")));
});

test("a new test that passes on the base → exit 4 naming the test", async (t) => {
  const f = fixture(t, "tests");
  assert.equal(await f.run(() => writeFileSync(f.file, source(1, true))), 4);
  assert.match(f.messages.join("\n"), /acceptance.test.mjs.*acceptance 0/);
  assert.equal(existsSync(f.lock), false);
  assert.equal(f.git("worktree", "list", "--porcelain").match(/^worktree /gm).length, 1);
  // The merge base, rather than the run-start HEAD, must supply implementation code.
  const green = fixture(t, "tests");
  writeFileSync(path.join(green.worktree, "value.mjs"), "export const value = true;\n");
  green.git("add", "."); green.git("commit", "-qm", "implementation");
  assert.equal(await green.run(() => writeFileSync(green.file, "import test from 'node:test';\nimport { value } from './value.mjs';\ntest('requires implementation', () => { if (!value) throw Error('base red'); });\n")), 0);
  const escaped = fixture(t, "tests");
  const outside = path.join(escaped.root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, path.join(escaped.worktree, "suite"), "dir");
  escaped.git("add", "."); escaped.git("commit", "-qm", "base symlink");
  escaped.git("branch", "-f", "base", "HEAD");
  rmSync(path.join(escaped.worktree, "suite"));
  mkdirSync(path.join(escaped.worktree, "suite", "created-outside"), { recursive: true });
  writeFileSync(path.join(escaped.worktree, "suite", "created-outside", "a.test.mjs"), source(1));
  const { verifyBaseTests } = await import("./locked-tests.mjs");
  await assert.rejects(verifyBaseTests(escaped.worktree, escaped.git("rev-parse", "base"), [{ path: "suite/created-outside/a.test.mjs", name: "acceptance 0" }]), /unsafe base test path/);
  assert.equal(existsSync(path.join(outside, "created-outside")), false);
  assert.equal(existsSync(escaped.lock), false);
  assert.equal(escaped.git("worktree", "list", "--porcelain").match(/^worktree /gm).length, 1);
  const custom = fixture(t, "tests", { tests: { command: [process.execPath, "probe.mjs"] } });
  writeFileSync(path.join(custom.worktree, "probe.mjs"), "import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2] + '.ran', 'yes');\nprocess.exit(7);\n");
  custom.git("add", "."); custom.git("commit", "-qm", "custom runner");
  custom.git("branch", "-f", "base", "HEAD");
  assert.equal(await custom.run(() => writeFileSync(custom.file, source(1))), 0);
  assert.equal(custom.git("worktree", "list", "--porcelain").match(/^worktree /gm).length, 1);
});

test("locked file edited → exit 4", async (t) => {
  for (const mode of ["edit", "delete", "cap", "tamper lock", "delete lock"]) {
    const f = fixture(t);
    writeFileSync(f.file, source(1, true)); f.git("add", "."); f.git("commit", "-qm", "tests"); f.seal();
    assert.equal(await f.run(() => {
      if (mode === "edit") writeFileSync(f.file, source(2, true));
      if (mode === "delete") rmSync(f.file);
      if (mode === "cap") writeFileSync(path.join(f.worktree, "extra.test.mjs"), source(5, true));
      if (mode === "tamper lock") { writeFileSync(f.file, source(2, true)); f.seal(); }
      if (mode === "delete lock") rmSync(f.lock);
    }), 4);
    assert.match(f.messages.join("\n"), mode === "cap" ? /maxExtraCases.*4/ : /acceptance.test.mjs/);
    assert.equal(f.checks.length, 0);
  }
});

test("locked file renamed → exit 4", async (t) => {
  const f = fixture(t);
  writeFileSync(f.file, source(1, true)); f.git("add", "."); f.git("commit", "-qm", "tests"); f.seal();
  assert.equal(await f.run(() => renameSync(f.file, path.join(f.worktree, "renamed.test.mjs"))), 4);
  assert.match(f.messages.join("\n"), /acceptance.test.mjs/);
});

test("marker written but a locked test fails → exit 3, not 0", async (t) => {
  for (const existing of [false, true]) {
    const option = fixture(t);
    const optionFile = path.join(option.worktree, "--acceptance.test.mjs");
    writeFileSync(optionFile, source(1, true));
    option.git("add", "."); option.git("commit", "-qm", "option-like test");
    mkdirSync(path.dirname(option.lock), { recursive: true });
    writeFileSync(option.lock, JSON.stringify({ "--acceptance.test.mjs": createHash("sha256").update(readFileSync(optionFile)).digest("hex") }));
    if (existing) writeFileSync(option.progress, DONE_MARKER);
    assert.equal(await option.run(), 0);
    assert.equal(option.checks.length, 1);
    const f = fixture(t);
    writeFileSync(f.file, source(1)); f.git("add", "."); f.git("commit", "-qm", "tests"); f.seal();
    if (existing) writeFileSync(f.progress, DONE_MARKER);
    assert.equal(await f.run(), 3);
  }
  for (const checkStatus of [0, 1]) {
    const f = fixture(t);
    writeFileSync(f.file, source(1, true)); f.git("add", "."); f.git("commit", "-qm", "tests"); f.seal();
    writeFileSync(f.progress, DONE_MARKER);
    assert.equal(await f.run(undefined, { runCheck: async (command, cwd) => {
      assert.deepEqual(command, ["npx", "qc", "check"]); assert.equal(cwd, f.worktree); return checkStatus;
    } }), checkStatus === 0 ? 0 : 3);
  }
  const custom = fixture(t, "implement", { tests: { command: [process.execPath, "probe.mjs", "--literal"] } });
  writeFileSync(path.join(custom.worktree, "probe.mjs"), "import { writeFileSync } from 'node:fs';\nwriteFileSync('args.json', JSON.stringify(process.argv.slice(2)));\n");
  writeFileSync(custom.file, source(1)); custom.git("add", "."); custom.git("commit", "-qm", "custom runner"); custom.seal();
  assert.equal(await custom.run(), 0);
  assert.deepEqual(JSON.parse(readFileSync(path.join(custom.worktree, "args.json"))), ["--literal", custom.file]);
  assert.equal(custom.checks.length, 1);
  const incomplete = fixture(t);
  writeFileSync(incomplete.file, source(1, true)); incomplete.git("add", "."); incomplete.git("commit", "-qm", "tests"); incomplete.seal();
  assert.equal(await incomplete.run(undefined, { run: async () => ({ status: 0 }) }), 3);
  assert.equal(incomplete.checks.length, 1);
});

test("without a lock the runner keeps its existing exits and does not run tests", async (t) => {
  for (const marked of [false, true]) {
    const f = fixture(t);
    assert.equal(await f.run(() => writeFileSync(f.file, source(9)), marked ? {} : { run: async () => ({ status: 0 }) }), marked ? 0 : 3);
    assert.deepEqual(f.checks, []);
  }
});
