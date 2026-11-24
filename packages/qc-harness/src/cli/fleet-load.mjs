import os from "node:os";

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
  return { cpu, mem: round(1 - host.freemem() / host.totalmem()), sample };
}
