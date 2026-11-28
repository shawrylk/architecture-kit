import assert from "node:assert/strict";
import { test } from "node:test";
import { BYTES_PER_SLOT, jobCapacity, jobSlots } from "./fleet-capacity.mjs";

const GiB = 1024 ** 3;
const host = ({ cpus = 16, total = 32 * GiB, free = 24 * GiB, platform = "linux" } = {}) =>
  ({ availableParallelism: () => cpus, cpus: () => [], totalmem: () => total, freemem: () => free, platform: () => platform });

test("capacity takes the smaller of the core bound and the memory bound", () => {
  assert.equal(jobCapacity({ cpus: 16, totalMem: 64 * GiB, freeMem: 60 * GiB }), 8);
  assert.equal(jobCapacity({ cpus: 16, totalMem: 64 * GiB, freeMem: 5 * GiB }), 2);
  assert.equal(jobCapacity({ cpus: 16, totalMem: 64 * GiB, freeMem: 3 * BYTES_PER_SLOT - 1 }), 2);
});

test("capacity is at least one slot on a small or busy machine", () => {
  assert.equal(jobCapacity({ cpus: 1, totalMem: 2 * GiB, freeMem: 0 }), 1);
  assert.equal(jobCapacity({ cpus: 8, totalMem: 16 * GiB, freeMem: 100 }), 1);
});

test("capacity has no fixed ceiling on a large machine", () => {
  assert.equal(jobCapacity({ cpus: 128, totalMem: 512 * GiB, freeMem: 480 * GiB }), 64);
});

test("capacity never drops below the live jobs", () => {
  assert.equal(jobCapacity({ cpus: 16, totalMem: 32 * GiB, freeMem: 1 * GiB, live: 5 }), 5);
});

test("macOS counts half of the total memory when it reports low free memory", () => {
  assert.equal(jobCapacity({ cpus: 12, totalMem: 32 * GiB, freeMem: 1 * GiB, platform: "darwin" }), 6);
  assert.equal(jobCapacity({ cpus: 12, totalMem: 32 * GiB, freeMem: 1 * GiB, platform: "linux" }), 1);
});

test("a number caps the slots and 0 turns jobs off", () => {
  assert.equal(jobSlots("auto", { host: host() }), 8);
  assert.equal(jobSlots(3, { host: host() }), 3);
  assert.equal(jobSlots(20, { host: host() }), 8);
  assert.equal(jobSlots(0, { host: host(), live: 0 }), 0);
});
