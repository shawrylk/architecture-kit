import os from "node:os";

// A Codex loop and the build or test it starts keep about two logical cores busy.
export const CORES_PER_SLOT = 2;
// A job checkout peaks near 2.5 GB while it installs packages, type-checks and runs tests.
export const BYTES_PER_SLOT = 2.5 * 1024 ** 3;
// macOS keeps most idle memory as cache and reports low free memory, so it counts half of the total instead.
export const MAC_MEMORY_SHARE = 0.5;

/** Count the job slots that this machine can hold now. The result is never below the live jobs or 1. */
export function jobCapacity({ cpus, totalMem, freeMem, live = 0, platform = process.platform }) {
  const available = platform === "darwin" ? Math.max(freeMem, totalMem * MAC_MEMORY_SHARE) : freeMem;
  const byCores = Math.floor(cpus / CORES_PER_SLOT), byMemory = Math.floor(available / BYTES_PER_SLOT);
  return Math.max(1, live, Math.min(byCores, byMemory));
}

export const validJobMode = value => value === "auto" || (Number.isSafeInteger(value) && value >= 0);

/** In auto mode, slots follow capacity. A number caps that capacity, and 0 turns jobs off. */
export function jobSlots(mode, { host = os, live = 0 } = {}) {
  const capacity = jobCapacity({ cpus: host.availableParallelism?.() ?? host.cpus().length, totalMem: host.totalmem(),
    freeMem: host.freemem(), live, platform: host.platform?.() ?? process.platform });
  return mode === "auto" ? capacity : Math.min(mode, capacity);
}
