import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { heartbeat, receiveMessage } from "./fleet-node.mjs";
import { overloaded } from "./fleet-assign.mjs";
import { readState, writeState } from "./fleet-state.mjs";
import { sampleLoad } from "./fleet-load.mjs";

const fakeOS = times => ({ cpus: () => times.map(times => ({ times })), freemem: () => 247, totalmem: () => 1000 });
test("first CPU sample is unknown; memory and CPU deltas round to two decimals", () => {
  const first = sampleLoad({ os: fakeOS([{ user: 20, nice: 0, sys: 10, idle: 70, irq: 0 }, { user: 10, idle: 90 }]) });
  assert.equal(first.cpu, null);
  assert.equal(first.mem, 0.75);
  const second = sampleLoad({ os: fakeOS([{ user: 50, nice: 0, sys: 20, idle: 130, irq: 0 }, { user: 20, idle: 180 }]), previous: first.sample });
  assert.equal(second.cpu, 0.25);
  assert.equal(sampleLoad({ os: fakeOS([{ user: 20, nice: 0, sys: 10, idle: 70, irq: 0 }, { user: 10, idle: 90 }]), previous: first.sample }).cpu, null);
});


test("macOS memory load counts active, wired and compressed pages only", () => {
  const vmStat = () => "Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 5.\nPages active: 30.\nPages inactive: 400.\nPages wired down: 15.\nPages occupied by compressor: 5.\n";
  const mac = { cpus: () => [], freemem: () => 4096 * 5, totalmem: () => 4096 * 500, platform: () => "darwin", vmStat };
  assert.equal(sampleLoad({ os: mac }).mem, 0.1);
  assert.equal(sampleLoad({ os: { ...mac, vmStat: () => "garbage" } }).mem, 0.5);
});

test("load samples report the host platform", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const load = sampleLoad({ os: { ...fakeOS([{ user: 10, idle: 90 }]), platform: () => platform } });
    assert.equal(load.platform, platform);
  }
});


test("darwin platform reaches local and remote heartbeat loads", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-load-"));
  mkdirSync(path.join(root, ".git"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const fleet = { self: "a", secret: "ab".repeat(32), nodes: [
    { id: "a", address: "localhost" }, { id: "b", address: "localhost" },
  ] };
  writeState(root, "node", { leader: true, term: 1 });
  const sent = [];
  await heartbeat({ root, fleet, repo: "o/r", leader: true,
    os: { ...fakeOS([{ user: 10, idle: 90 }]), freemem: () => 50, platform: () => "darwin" },
    fetch: async (_url, options) => { sent.push(JSON.parse(options.body)); return { status: 202 }; },
  });
  const load = readState(root, "peers").a.load;
  assert.equal(load.platform, "darwin");
  assert.equal(load.mem, 0.95);
  assert.deepEqual(overloaded(load), []);
  assert.equal(sent[0].body.load.platform, "darwin");
  assert.deepEqual(receiveMessage({ root, fleet, message: sent[0] }), { ok: true });
  assert.equal(readState(root, "peers").a.load.platform, "darwin");
});
