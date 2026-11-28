import { execFileSync } from "node:child_process";
import os from "node:os";

// When vm_stat fails, macOS counts half of the total memory as free: most of its idle memory is cache.
export const MAC_MEMORY_SHARE = 0.5;
const runVmStat = () => execFileSync("vm_stat", { encoding: "utf8", timeout: 2000 });

/** Bytes that macOS cannot give back: active, wired and compressed pages. Cache and inactive pages are not in it. */
export function macUsedBytes(text) {
  const page = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  const pages = name => Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(text)?.[1]);
  const used = (pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor")) * page;
  if (!Number.isFinite(used)) throw new Error("vm_stat output has no page counts");
  return used;
}

/** Free memory that a new job can use. `os.freemem()` on macOS leaves out the cache, so it reads near zero on an idle machine. */
export function freeMemory(host = os) {
  const platform = host.platform?.() ?? os.platform();
  const vmStat = host.vmStat ?? (host === os ? runVmStat : undefined);
  if (platform !== "darwin" || !vmStat) return host.freemem();
  try { return Math.max(0, host.totalmem() - macUsedBytes(vmStat())); }
  catch { return Math.max(host.freemem(), host.totalmem() * MAC_MEMORY_SHARE); }
}

const round = value => Math.round(value * 100) / 100;

/** CPU counter deltas work across operating systems, including Windows. */
export function sampleLoad({ os: host = os, previous } = {}) {
  const sample = host.cpus().map(({ times }) => ({ idle: times.idle,
    total: Object.values(times).reduce((sum, value) => sum + value, 0) }));
  let cpu = null;
  if (previous?.length === sample.length && sample.length) {
    const total = sample.reduce((sum, value, index) => sum + value.total - previous[index].total, 0);
    const idle = sample.reduce((sum, value, index) => sum + value.idle - previous[index].idle, 0);
    if (total > 0 && idle >= 0 && idle <= total && sample.every((value, index) => value.total >= previous[index].total && value.idle >= previous[index].idle)) {
      cpu = round(1 - idle / total);
    }
  }
  return { platform: host.platform?.() ?? os.platform(), cpu, mem: round(1 - freeMemory(host) / host.totalmem()), sample };
}
