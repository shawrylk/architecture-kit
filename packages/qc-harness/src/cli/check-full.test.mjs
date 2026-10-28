import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFullCheck } from "./check.mjs";

function fixture(overrides = {}) {
  const records = [], calls = [];
  const options = {
    platform: 'win32', git: (...args) => args[0] === 'status' ? '' : 'head',
    gates: async () => ({ problems: [], lines: [] }), commands: async () => 0,
    suite: async () => 0, record: (_root, value) => records.push(value),
    spawn: (cmd, args) => { calls.push([cmd, args]); return { status: 0 }; },
    nodeMajor: () => '22', write: () => {}, ...overrides,
  };
  return { options, records, calls };
}
const config = { root: 'C:\\repo with space', check: {} };
test('full check runs gates, commands, and suite, then records the clean host head', async () => {
  const order = [];
  const { options, records } = fixture({
    gates: async () => { order.push('gates'); return { problems: [], lines: [] }; },
    commands: async () => { order.push('commands'); return 0; },
    suite: async () => { order.push('suite'); return 0; },
  });
  assert.equal(await runFullCheck(config, [], options), 0);
  assert.deepEqual(order, ['gates', 'commands', 'suite']);
  assert.deepEqual(records, [{ type: 'leg', os: 'windows', head: 'head', source: 'local' }]);
});
for (const stage of ['gates', 'commands', 'suite', 'dirty', 'head changed']) {
  test(`records no evidence for ${stage}`, async () => {
    let heads = 0;
    const { options, records } = fixture({
      ...(stage === 'gates' ? { gates: async () => ({ problems: [{ path: 'a', rule: 'bad', detail: 'bad' }], lines: [] }) } : {}),
      ...(stage === 'commands' ? { commands: async () => 1 } : {}),
      ...(stage === 'suite' ? { suite: async () => 1 } : {}),
      ...(stage === 'dirty' ? { git: (...args) => args[0] === 'status' ? ' M a' : 'head' } : {}),
      ...(stage === 'head changed' ? { git: (...args) => args[0] === 'status' ? '' : String(heads++) } : {}),
    });
    await runFullCheck(config, [], options);
    assert.deepEqual(records, []);
  });
}
test('Windows uses Docker and engines Node major for a Linux leg', async () => {
  const { options, calls, records } = fixture();
  assert.equal(await runFullCheck(config, ['--os', 'linux'], options), 0);
  assert.equal(calls[0][0], 'docker');
  assert.ok(calls[1][1].includes('node:22'));
  assert.ok(calls[1][1].includes('type=bind,source=C:\\repo with space,target=/workspace'));
  assert.ok(calls[1][1].some((arg) => arg.startsWith('QC_PLATFORM_GIT_DIR=/qc-git')));
  assert.ok(calls[1][1].every((arg) => !arg.startsWith('GIT_DIR=') && !arg.startsWith('GIT_WORK_TREE=')));
  assert.match(calls[1][1].at(-1), /mktemp -d.*git -c core.autocrlf=false -c core.eol=lf --git-dir="\$QC_PLATFORM_GIT_DIR" archive --format=tar --output="\$qc_tree\/source.tar" 'head'/);
  assert.doesNotMatch(calls[1][1].at(-1), /tar --exclude/);
  assert.equal(records[0].os, 'linux');
});
test('Windows falls back to WSL when Docker is absent', async () => {
  const { options, records, calls } = fixture();
  options.spawn = (cmd, args) => { calls.push([cmd, args]); return cmd === 'docker' ? { error: new Error('absent') } : { status: 0, stdout: '/mnt/c/repo\n' }; };
  assert.equal(await runFullCheck(config, ['--os', 'linux'], options), 0);
  assert.equal(calls.at(-1)[0], 'wsl');
  assert.ok(calls.at(-1)[1].includes('/mnt/c/repo'));
  assert.ok(calls.at(-1)[1].every((arg) => !arg.startsWith('GIT_DIR=') && !arg.startsWith('GIT_WORK_TREE=')));
  assert.doesNotMatch(calls.at(-1)[1].at(-1), /corepack enable/);
  assert.match(calls.at(-1)[1].at(-1), /git -c core.autocrlf=false -c core.eol=lf --git-dir="\$QC_PLATFORM_GIT_DIR" archive --format=tar --output="\$qc_tree\/source.tar" 'head'/);
  assert.equal(records[0].os, 'linux');
});

test('the Linux view uses the pinned head bytes despite a CRLF checkout and later edits', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'qc-linux-bytes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'core.autocrlf', 'true');
  writeFileSync(path.join(root, 'source.sh'), 'echo stored\n');
  git('add', 'source.sh');
  git('commit', '-m', 'fixture');
  rmSync(path.join(root, 'source.sh'));
  git('checkout', '--', 'source.sh');
  assert.equal(readFileSync(path.join(root, 'source.sh'), 'utf8'), 'echo stored\r\n');
  const head = git('rev-parse', 'HEAD');
  const { options, calls } = fixture({ git });
  assert.equal(await runFullCheck({ root, check: {} }, ['--os', 'linux'], options), 0);
  writeFileSync(path.join(root, 'source.sh'), 'echo edited\r\n');
  writeFileSync(path.join(root, 'untracked.sh'), 'echo untracked\r\n');
  git('add', 'source.sh');
  git('commit', '-m', 'later fixture');
  assert.notEqual(git('rev-parse', 'HEAD'), head);
  const script = calls[1][1].at(-1).split('corepack enable && ')[0];
  const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : 'sh';
  assert.ok(process.platform !== 'win32' || existsSync(bash), 'Git Bash is required on Windows');
  const result = spawnSync(bash, ['-xc', `${script}test "$(cat source.sh)" = 'echo stored' && test "$(wc -c < source.sh)" -eq 12 && test ! -e untracked.sh`], {
    cwd: root, encoding: 'utf8', env: { ...process.env, QC_PLATFORM_GIT_DIR: git('rev-parse', '--absolute-git-dir') },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
test('failed Docker run produces no leg and does not retry in WSL', async () => {
  const { options, records, calls } = fixture();
  options.spawn = (cmd, args) => { calls.push([cmd, args]); return { status: args[0] === 'info' ? 0 : 1 }; };
  assert.equal(await runFullCheck(config, ['--os', 'linux'], options), 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(records, []);
});
test('rejects unknown arguments and unsupported target hosts', async () => {
  const { options, records } = fixture({ platform: 'linux' });
  assert.equal(await runFullCheck(config, ['--os', 'windows'], options), 1);
  assert.equal(await runFullCheck(config, ['a.mjs'], options), 1);
  assert.deepEqual(records, []);
});

test('unavailable WSL records no Linux evidence', async () => {
  const { options, records } = fixture({ spawn: () => ({ status: 1 }) });
  assert.equal(await runFullCheck(config, ['--os', 'linux'], options), 1);
  assert.deepEqual(records, []);
});

test('the parent records its temporary view without suppressing evidence in nested fixtures', async (t) => {
  const previous = process.env.QC_PLATFORM_LEG_PARENT;
  process.env.QC_PLATFORM_LEG_PARENT = config.root;
  t.after(() => {
    if (previous === undefined) delete process.env.QC_PLATFORM_LEG_PARENT;
    else process.env.QC_PLATFORM_LEG_PARENT = previous;
  });
  const { options, records } = fixture();
  assert.equal(await runFullCheck(config, [], options), 0);
  assert.deepEqual(records, []);
  assert.equal(await runFullCheck({ ...config, root: 'another-fixture' }, [], options), 0);
  assert.equal(records.length, 1);
});
