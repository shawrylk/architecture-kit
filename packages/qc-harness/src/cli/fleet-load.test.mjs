import { strict as assert } from "node:assert";
import { test } from "node:test";
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
