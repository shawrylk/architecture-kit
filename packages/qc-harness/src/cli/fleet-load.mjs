import os from "node:os";

const round = value => Math.round(value * 100) / 100;

/** CPU counter deltas work across operating systems, including Windows. */
export function sampleLoad({ os: host = os, previous, previousLoad, clock = Date.now } = {}) {
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
  const observed = { ...previousLoad?.observed, mem: clock() };
  if (cpu !== null) observed.cpu = clock();
  return { cpu: cpu ?? previousLoad?.cpu ?? null, mem: round(1 - host.freemem() / host.totalmem()), sample, observed };
}

export const metrics = ["cpu", "mem", "rtt"];
export const metricTime = (load, key, fallback) => load?.observed?.[key] ?? fallback;
export const metricFresh = (load, key, now, fallback) => {
  const at = metricTime(load, key, fallback);
  return Number.isFinite(at) && now - at >= 0 && now - at <= 300_000;
};

/** Scheduling sees only measurements made within the last five minutes. */
export function freshLoad(load, now, fallback) {
  return Object.fromEntries(metrics.map(key => [key, metricFresh(load, key, now, fallback) ? load?.[key] ?? null : null]));
}

/** Missing readings never erase or rejuvenate an earlier measurement. */
export function mergeLoad(previous, incoming, measuredAt, previousAt) {
  const load = { cpu: null, mem: null, rtt: null, observed: {} };
  for (const key of metrics) {
    const before = metricTime(previous, key, previousAt), at = metricTime(incoming, key, measuredAt);
    if (previous?.[key] != null) {
      load[key] = previous[key];
      if (Number.isFinite(before)) load.observed[key] = before;
    }
    if (incoming?.[key] != null && (!Number.isFinite(before) || at >= before)) {
      load[key] = incoming[key];
      load.observed[key] = at;
    }
  }
  return load;
}
