import { test } from "node:test";
import assert from "node:assert/strict";
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
  assert.match(calls[1][1].at(-1), /mktemp -d.*tar --exclude=\.git --exclude=node_modules/);
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
  assert.equal(records[0].os, 'linux');
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
