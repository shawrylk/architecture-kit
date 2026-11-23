import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCiPreview } from "./ci-preview.mjs";

function fixture(t, jobs = [{ name: 'test (ubuntu-latest)', conclusion: 'success' }, { name: 'test (windows-latest)', conclusion: 'success' }]) {
  const root = mkdtempSync(path.join(tmpdir(), 'qc-preview-'));
  mkdirSync(path.join(root, '.git'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [], records = [];
  let lists = 0;
  const options = {
    git: (...args) => args[0] === 'branch' ? 'feat/test' : 'abc123',
    gh: (args) => {
      calls.push(args);
      if (args[0] === 'workflow') return '';
      if (args[1] === 'list') return lists++ === 0 ? '[]' : JSON.stringify([{ databaseId: 7, headSha: 'abc123' }]);
      if (args[1] === 'view') return JSON.stringify({ headSha: 'abc123', jobs });
      return '';
    },
    records: () => records,
    record: (_root, record) => records.push(record),
    sleep: async () => {}, attempts: 2, write: () => {},
  };
  return { root, options, calls, records };
}
test('dispatches both, waits, and records each passing leg once', async (t) => {
  const { root, options, calls, records } = fixture(t);
  assert.equal(await runCiPreview(root, ['--os', 'both'], options), 0);
  assert.deepEqual(calls[1], ['workflow', 'run', 'ci.yml', '--ref', 'feat/test', '-f', 'os=both']);
  assert.ok(calls.some((args) => args[1] === 'watch' && args.includes('7')));
  assert.deepEqual(records.filter((r) => r.type === 'leg').map((r) => r.os), ['linux', 'windows']);
  assert.equal(await runCiPreview(root, ['--os', 'windows'], options), 1);
  assert.equal(calls.filter((args) => args[0] === 'workflow').length, 1);
});
test('records only the successful platform when another fails', async (t) => {
  const { root, options, records } = fixture(t, [{ name: 'linux', conclusion: 'success' }, { name: 'windows', conclusion: 'failure' }]);
  assert.equal(await runCiPreview(root, ['--os', 'both'], options), 1);
  assert.deepEqual(records.filter((r) => r.type === 'leg').map((r) => r.os), ['linux']);
});
test('refuses invalid input and detached heads before dispatch', async (t) => {
  const { root, options, calls } = fixture(t);
  assert.equal(await runCiPreview(root, ['--os', 'mac'], options), 1);
  options.git = (...args) => args[0] === 'branch' ? '' : 'head';
  assert.equal(await runCiPreview(root, [], options), 1);
  assert.deepEqual(calls, []);
});
test('does not credit a stale run or missing platform jobs', async (t) => {
  const { root, options, records } = fixture(t, []);
  assert.equal(await runCiPreview(root, ['--os', 'linux'], options), 1);
  assert.equal(records.filter((r) => r.type === 'leg').length, 0);
});
test('a lookup failure dispatches nothing and reserves nothing', async (t) => {
  const { root, options, records } = fixture(t);
  options.gh = () => { throw new Error('offline'); };
  assert.equal(await runCiPreview(root, [], options), 1);
  assert.deepEqual(records, []);
});
test('dispatch failure retains the reservation and prevents a second preview', async (t) => {
  const { root, options, records } = fixture(t);
  const original = options.gh;
  options.gh = (args) => { if (args[0] === 'workflow') throw new Error('offline'); return original(args); };
  assert.equal(await runCiPreview(root, ['--os', 'linux'], options), 1);
  assert.equal(records[0].type, 'leg-preview');
  assert.equal(await runCiPreview(root, ['--os', 'linux'], options), 1);
  assert.equal(records.length, 1);
});
test('rejects stale head results and times out when no new run appears', async (t) => {
  const { root, options, records } = fixture(t);
  const original = options.gh;
  options.gh = (args) => args[1] === 'view' ? JSON.stringify({ headSha: 'stale', jobs: [] }) : original(args);
  assert.equal(await runCiPreview(root, ['--os', 'linux'], options), 1);
  assert.equal(records.filter((r) => r.type === 'leg').length, 0);
  options.git = (...args) => args[0] === 'branch' ? 'feat/test' : 'new-head';
  options.gh = () => '[]';
  assert.equal(await runCiPreview(root, ['--os', 'linux'], options), 1);
  assert.equal(records.filter((r) => r.type === 'leg').length, 0);
});
test('a failed job prevents credit even when another job for that platform passes', async (t) => {
  const { root, options, records } = fixture(t, [{ name: 'linux unit', conclusion: 'success' }, { name: 'linux integration', conclusion: 'failure' }]);
  assert.equal(await runCiPreview(root, ['--os', 'linux'], options), 1);
  assert.equal(records.filter((r) => r.type === 'leg').length, 0);
});
