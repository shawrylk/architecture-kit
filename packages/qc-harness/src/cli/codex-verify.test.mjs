import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { commandsOf, runShell, validatePaths, verifyBrief } from "./codex-verify.mjs";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-verify-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { worktree: dir, brief: path.join(dir, "brief.md"), progress: path.join(dir, "progress.md") };
}

test("Paths accepts quoted ownership, a manifest design, and the read-only review form", () => {
  for (const brief of ['Paths: `src/a.mjs`, and `src/b.mjs`', 'Paths: `package.json`\n## Design\nDependencies: none', 'Paths: none. Read-only review.']) {
    assert.doesNotThrow(() => validatePaths(brief));
  }
  for (const value of ['src/a.mjs', '`src/a.mjs` prose', '`src/a.mjs` andmore', '``']) {
    assert.throws(() => validatePaths(`Paths: ${value}`), /unparsed text/);
  }
});

test("Verify and Live commands preserve shell syntax and reject unquoted commands", () => {
  assert.deepEqual(commandsOf('Verify: `echo one && echo two`, and `echo three`\nVerify: `echo four`', "Verify"), ['echo one && echo two', 'echo three', 'echo four']);
  assert.deepEqual(commandsOf('Paths: `src`', "Live"), []);
  for (const value of ['node check.mjs', '`echo ok`, node check.mjs', '']) {
    assert.throws(() => commandsOf(`Verify: ${value}`, "Verify"), /Verify:.*backticks/);
  }
});

test("shell verification supports operators, worktree cwd, output tails and nonzero exits", async (t) => {
  const f = fixture(t);
  const result = await runShell('echo first && node -e "console.log(process.cwd()); console.error(\'last\'); process.exit(6)"', { cwd: f.worktree });
  assert.equal(result.status, 6);
  assert.ok(result.tail.includes(f.worktree));
  assert.match(result.tail, /last/);
  assert.ok(result.seconds >= 0);
});

test("a timed out shell command fails and terminates its process tree", async (t) => {
  const f = fixture(t);
  const start = Date.now();
  const result = await runShell('node -e "setInterval(()=>{},1000)"', { cwd: f.worktree, timeout: 100 });
  assert.equal(result.status, 124);
  assert.match(result.tail, /timed out/);
  assert.ok(Date.now() - start < 10000);
});

test("review roles skip Verify and Live and a brief with neither needs no report", async (t) => {
  const f = fixture(t);
  writeFileSync(f.brief, 'Verify: `node -e "process.exit(9)"`\nLive: `node -e "process.exit(9)"`');
  assert.equal(await verifyBrief({ ...f, review: true }), true);
  writeFileSync(f.brief, "Paths: `src`\n");
  assert.equal(await verifyBrief(f), true);
  assert.equal(existsSync(`${f.progress}.report.md`), false);
});

test("Live failures keep proof, stop later commands and clean their temporary directory", async (t) => {
  const f = fixture(t);
  writeFileSync(f.brief, 'Live: `node -e "console.log(process.cwd()); process.exit(8)"`, `node -e "process.exit(9)"`\n');
  assert.equal(await verifyBrief(f), false);
  const proof = readFileSync(`${f.progress}.report.md`, "utf8");
  assert.match(proof, /exit 8 in [\d.]+ s/);
  assert.doesNotMatch(proof, /exit 9 in/);
  const folder = proof.trimEnd().split(/\r?\n/).at(-1);
  assert.equal(existsSync(folder), false);
  assert.ok(path.basename(folder).startsWith("qc-codex-live-"));
});

test("proof-write failures prevent acceptance of an otherwise successful command", async (t) => {
  const f = fixture(t);
  writeFileSync(f.brief, 'Report: .\nVerify: `echo ok`\n');
  await assert.rejects(verifyBrief(f), /EISDIR|EPERM|EACCES/);
});

test("completion still requires the progress marker after verification commands finish", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const { DONE_MARKER, runCodexImplement } = await import("./codex-implement.mjs");
  const f = fixture(t);
  const initialized = spawnSync("git", ["init", "-q", f.worktree], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  writeFileSync(f.progress, `${DONE_MARKER}\n`);
  writeFileSync(f.brief, '# Brief\nPaths: `src`\n## Product decisions\nKeep the marker.\nVerify: `node -e "require(\'node:fs\').unlinkSync(\'progress.md\')"`\n');
  const lines = [];
  assert.equal(await runCodexImplement(["--brief", f.brief, "--progress", f.progress, "--worktree", f.worktree], {
    say: () => {}, out: (line) => lines.push(line), run: async () => assert.fail("marker exists at startup"),
  }), 3);
  assert.deepEqual(lines, ["exit 3"]);
});
