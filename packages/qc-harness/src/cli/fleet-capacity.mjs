import os from "node:os";
import { freeMemory } from "./fleet-load.mjs";

// A Codex loop and the build or test it starts keep about two logical cores busy.
export const CORES_PER_SLOT = 2;
// A job checkout peaks near 2.5 GB while it installs packages, type-checks and runs tests.
export const BYTES_PER_SLOT = 2.5 * 1024 ** 3;

/** Count the job slots that this machine can hold now. The result is never below the live jobs or 1. */
export function jobCapacity({ cpus, freeMem, live = 0 }) {
  const byCores = Math.floor(cpus / CORES_PER_SLOT), byMemory = Math.floor(freeMem / BYTES_PER_SLOT);
  return Math.max(1, live, Math.min(byCores, byMemory));
}

export const validJobMode = value => value === "auto" || (Number.isSafeInteger(value) && value >= 0);

/** In auto mode, slots follow capacity. A number is the owner's choice: it sets the slots as given, above capacity too, and 0 turns jobs off. */
export function jobSlots(mode, { host = os, live = 0 } = {}) {
  if (mode !== "auto") return mode;
  return jobCapacity({ cpus: host.availableParallelism?.() ?? host.cpus().length, freeMem: freeMemory(host), live });
}
