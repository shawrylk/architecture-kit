import assert from "node:assert/strict";
import { test } from "node:test";
import { BYTES_PER_SLOT, jobCapacity, jobSlots } from "./fleet-capacity.mjs";

const GiB = 1024 ** 3;
const host = ({ cpus = 16, total = 32 * GiB, free = 24 * GiB, platform = "linux" } = {}) =>
  ({ availableParallelism: () => cpus, cpus: () => [], totalmem: () => total, freemem: () => free, platform: () => platform });

test("capacity takes the smaller of the core bound and the memory bound", () => {
  assert.equal(jobCapacity({ cpus: 16, freeMem: 60 * GiB }), 8);
  assert.equal(jobCapacity({ cpus: 16, freeMem: 5 * GiB }), 2);
  assert.equal(jobCapacity({ cpus: 16, freeMem: 3 * BYTES_PER_SLOT - 1 }), 2);
});

test("capacity is at least one slot on a small or busy machine", () => {
  assert.equal(jobCapacity({ cpus: 1, freeMem: 0 }), 1);
  assert.equal(jobCapacity({ cpus: 8, freeMem: 100 }), 1);
});

test("capacity has no fixed ceiling on a large machine", () => {
  assert.equal(jobCapacity({ cpus: 128, freeMem: 480 * GiB }), 64);
});

test("capacity never drops below the live jobs", () => {
  assert.equal(jobCapacity({ cpus: 16, freeMem: 1 * GiB, live: 5 }), 5);
});

test("macOS slots follow the memory that vm_stat reports as in use, not os.freemem", () => {
  const vmStat = () => "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1000.\nPages active: 300000.\nPages inactive: 500000.\nPages wired down: 150000.\nPages occupied by compressor: 50000.\n";
  const mac = { ...host({ cpus: 12, total: 24 * GiB, free: 0.2 * GiB, platform: "darwin" }), vmStat };
  // 500000 pages of 16384 bytes are in use: 7.6 GiB of 24, so 16.4 GiB is free: six slots by memory, six by cores.
  assert.equal(jobSlots("auto", { host: mac }), 6);
  assert.equal(jobSlots("auto", { host: { ...mac, vmStat: () => { throw new Error("no vm_stat"); } } }), 4);
});

test("a number sets the slots as given and 0 turns jobs off", () => {
  assert.equal(jobSlots("auto", { host: host() }), 8);
  assert.equal(jobSlots(3, { host: host() }), 3);
  assert.equal(jobSlots(20, { host: host() }), 20);
  assert.equal(jobSlots(0, { host: host(), live: 0 }), 0);
});
