import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runAffectedCheck } from "./check.mjs";
import { appendLeg, legRecords, readyProblems, readyLines, runReadyCheck } from "./legs.mjs";

export function legFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "qc-legs-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(path.join(root, 'a.mjs'), 'export const value = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('branch', 'base');
  writeFileSync(path.join(root, 'qc.config.json'), JSON.stringify({ check: { base: 'base' }, ready: { platforms: ['linux', 'windows'] } }));
  return { root, git };
}

test('a safe head needs one current passing leg; risk needs every configured platform', async (t) => {
  const { root, git } = legFixture(t);
  git('add', '.'); git('commit', '-qm', 'config');
  const affected = (platform) => runAffectedCheck({ root }, {}, { platform, gates: async () => ({ problems: [], lines: [] }), commands: async () => 0 });
  const head = git('rev-parse', 'HEAD');
  assert.equal(readyProblems(root, head).missing.length, 2);
  const output = [];
  assert.equal(runReadyCheck(root, (line) => output.push(line)), 1);
  assert.equal(output.length, 1);
  appendLeg(root, { os: 'linux', head: 'old', source: 'local' });
  assert.equal(readyProblems(root, head).missing.length, 2);
  assert.equal(await affected('linux'), 0);
  assert.deepEqual(readyProblems(root, head).missing, []);
  assert.equal(runReadyCheck(root, () => assert.fail('a pass must be silent')), 0);
  writeFileSync(path.join(root, 'a.mjs'), 'process.platform;\nEPERM;\nlisten(3000);\n"\\r\\n";\n');
  git('add', 'a.mjs'); git('commit', '-qm', 'risk');
  const risky = git('rev-parse', 'HEAD');
  appendLeg(root, { os: 'linux', head: risky, source: 'preview' });
  const problems = readyProblems(root, risky);
  assert.deepEqual(problems.missing, ['windows']);
  assert.equal(readyLines(problems).length, 4);
  assert.match(readyLines(problems)[1], /a\.mjs:1/);
  assert.equal(await affected('win32'), 0);
  assert.deepEqual(readyLines(readyProblems(root, risky)), []);
});

test('a linked worktree reads legs from the common ledger', async (t) => {
  const { root, git } = legFixture(t);
  git('add', '.'); git('commit', '-qm', 'config');
  const linked = path.join(root, 'linked');
  git('worktree', 'add', '-qb', 'linked', linked);
  const head = git('rev-parse', 'HEAD');
  assert.equal(await runAffectedCheck({ root: linked }, {}, { platform: 'win32', gates: async () => ({ problems: [], lines: [] }), commands: async () => 0 }), 0);
  assert.equal(legRecords(root)[0].head, head);
});

test('leg records share the common ledger and tolerate torn lines', (t) => {
  const { root, git } = legFixture(t);
  mkdirSync(path.join(root, '.git', 'qc'), { recursive: true });
  writeFileSync(path.join(root, '.git', 'qc', 'ledger.jsonl'), '{torn');
  appendLeg(root, { os: 'linux', head: git('rev-parse', 'HEAD'), source: 'local' });
  assert.equal(legRecords(root).length, 1);
  assert.throws(() => appendLeg(root, { os: 'linux', head: 'x', source: 'affected' }), /invalid platform leg/);
  assert.throws(() => appendLeg(root, { os: 'linux', head: 'x', source: 'local', type: 'affected' }), /invalid platform leg type/);
  assert.throws(() => appendLeg(root, { os: 'freebsd', head: 'x', source: 'local' }), /platform/);
});


test('fleet Windows and macOS legs satisfy configured risky-head readiness', t => {
  const { root, git } = legFixture(t);
  writeFileSync(path.join(root, 'qc.config.json'), JSON.stringify({ check: { base: 'base' }, ready: { platforms: ['windows', 'darwin'] } }));
  writeFileSync(path.join(root, 'a.mjs'), 'process.platform;\n');
  git('add', '.'); git('commit', '-qm', 'risk');
  const head = git('rev-parse', 'HEAD');
  appendLeg(root, { os: 'windows', head, source: 'fleet' });
  assert.deepEqual(readyProblems(root, head).missing, ['darwin']);
  appendLeg(root, { os: 'darwin', head, source: 'fleet' });
  assert.deepEqual(readyProblems(root, head).missing, []);
});

test('affected checks on macOS record the native passing leg', async t => {
  const { root, git } = legFixture(t);
  git('add', '.'); git('commit', '-qm', 'config');
  const output = [];
  const code = await runAffectedCheck({ root }, {}, { platform: 'darwin', gates: async () => ({ problems: [], lines: [] }),
    commands: async () => 0, write: line => output.push(line) });
  assert.equal(code, 0, output.join('\n'));
  assert.equal(legRecords(root).at(-1).os, 'darwin');
});
