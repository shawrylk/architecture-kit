import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sampleLoad, freshLoad } from "./fleet-load.mjs";

const fakeOS = times => ({ cpus: () => times.map(times => ({ times })), freemem: () => 247, totalmem: () => 1000 });
test("first CPU sample is unknown; memory and CPU deltas round to two decimals", () => {
  const first = sampleLoad({ os: fakeOS([{ user: 20, nice: 0, sys: 10, idle: 70, irq: 0 }, { user: 10, idle: 90 }]) });
  assert.equal(first.cpu, null);
  assert.equal(first.mem, 0.75);
  const second = sampleLoad({ os: fakeOS([{ user: 50, nice: 0, sys: 20, idle: 130, irq: 0 }, { user: 20, idle: 180 }]), previous: first.sample });
  assert.equal(second.cpu, 0.25);
  assert.equal(sampleLoad({ os: fakeOS([{ user: 20, nice: 0, sys: 10, idle: 70, irq: 0 }, { user: 10, idle: 90 }]), previous: first.sample }).cpu, null);
});

test("first sample remains unknown", () => {
  const load = sampleLoad({ os: fakeOS([{ user: 10, idle: 90 }]), clock: () => 1000 });
  assert.equal(load.cpu, null);
  assert.equal(load.observed.cpu, undefined);
  assert.equal(load.observed.mem, 1000);
});

test("CPU retains valid reading across unchanged counters and recovers after reset or topology change", () => {
  let time = 1000;
  const take = (times, previous) => sampleLoad({ os: fakeOS(times), previous: previous?.sample,
    previousLoad: previous, clock: () => time++ });
  const first = take([{ user: 10, idle: 90 }]);
  const measured = take([{ user: 20, idle: 100 }], first);
  assert.equal(measured.cpu, 0.5);
  let last = measured;
  for (const counters of [[{ user: 20, idle: 100 }], [{ user: 1, idle: 9 }],
    [{ user: 1, idle: 9 }, { user: 1, idle: 9 }]]) {
    last = take(counters, last);
    assert.equal(last.cpu, 0.5);
    assert.equal(last.observed.cpu, measured.observed.cpu);
  }
  const recovered = take([{ user: 3, idle: 17 }, { user: 3, idle: 17 }], last);
  assert.equal(recovered.cpu, 0.2);
  assert.equal(recovered.observed.cpu, time - 1);
});

test("cached metrics never drive overload decisions after 300 seconds", async () => {
  const { overloaded } = await import("./fleet-assign.mjs");
  const load = { cpu: 1, mem: 1, rtt: 2200, observed: { cpu: 1000, mem: 2000, rtt: 1000 } };
  assert.equal(overloaded(freshLoad(load, 301000)).length, 3);
  assert.deepEqual(overloaded(freshLoad(load, 301001)), ["mem 100%"]);
  assert.deepEqual(overloaded(freshLoad(load, 302001)), []);
  assert.deepEqual(overloaded(freshLoad({ cpu: 1 }, 302001, 1000)), []);
});
