// `qc ci-wait <pr>`: wait on a pull request's checks, and return on the first thing worth acting on.
// A failure, a new head, a check stuck in the queue, and the time limit each end it, so it never waits forever.

import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

export const USAGE = `qc ci-wait — wait on a pull request's checks, with bounds

  qc ci-wait <pr> [--max <minutes>] [--queued <minutes>] [--first-wait <seconds>] [--interval <seconds>]

  Returns on the first of: every check done (exit 0); a check failed (1); a new head was pushed (3);
  a check queued longer than --queued, 25 by default (4); --max minutes, 50 by default (5).
  It reads the head after the first wait, since GitHub shows a push late.`;

export const EXIT = { green: 0, failed: 1, usage: 2, "new-head": 3, "stuck-queued": 4, timeout: 5 };
const DEFAULTS = { max: 50, queued: 25, firstWait: 90, interval: 60 };
const MINUTE_MS = 60_000;
const GH_TIMEOUT_MS = 30_000;
const QUEUED = new Set(["QUEUED", "PENDING", "WAITING", "REQUESTED", "EXPECTED"]);
const short = (sha) => (typeof sha === "string" ? sha.slice(0, 9) : "(unknown)");

/**
 * The outcome of one look at the checks, or null to keep waiting. `look` is `{ head, checks }`, where a null
 * `checks` is a read that failed. `watch` is `{ head0, startedMs, queuedSince }`, which the call updates.
 */
export function judge(look, watch, nowMs, limits) {
  if (watch.head0 === null && look.head) watch.head0 = look.head;
  if (look.head && watch.head0 && look.head !== watch.head0) return { why: "new-head", checks: [] };
  if (Array.isArray(look.checks)) {
    const failed = look.checks.filter((entry) => entry.bucket === "fail" || entry.bucket === "cancel");
    if (failed.length > 0) return { why: "failed", checks: failed };
    const pending = look.checks.filter((entry) => entry.bucket === "pending");
    if (look.checks.length > 0 && pending.length === 0) return { why: "green", checks: [] };
    const queued = new Set(pending.filter((entry) => QUEUED.has(String(entry.state).toUpperCase())).map((entry) => entry.name));
    for (const name of [...watch.queuedSince.keys()]) if (!queued.has(name)) watch.queuedSince.delete(name);
    for (const name of queued) if (!watch.queuedSince.has(name)) watch.queuedSince.set(name, nowMs);
    const stuck = pending.filter((entry) => queued.has(entry.name) && nowMs - watch.queuedSince.get(entry.name) >= limits.queued * MINUTE_MS);
    if (stuck.length > 0) return { why: "stuck-queued", checks: stuck };
  }
  if (nowMs - watch.startedMs >= limits.max * MINUTE_MS) return { why: "timeout", checks: [] };
  return null;
}

/** Waits on `pr` with the reads given. @returns the outcome, the first head, the minutes waited, and the last checks */
export async function ciWait(pr, limits, { readHead, readChecks, sleep, now }) {
  const startedMs = now();
  await sleep(limits.firstWait * 1000);
  const watch = { head0: readHead(pr), startedMs, queuedSince: new Map() };
  for (;;) {
    const look = { head: readHead(pr), checks: readChecks(pr) };
    const outcome = judge(look, watch, now(), limits);
    if (outcome) {
      const all = Array.isArray(look.checks) ? look.checks : [];
      return { ...outcome, head: watch.head0, minutes: Math.floor((now() - startedMs) / MINUTE_MS), all };
    }
    await sleep(limits.interval * 1000);
  }
}

/** One gh call whose output is JSON. gh exits non-zero while checks are pending, so the output decides, not the code. */
function ghJson(args, env) {
  const result = spawnSync("gh", args, { encoding: "utf8", windowsHide: true, timeout: GH_TIMEOUT_MS, env });
  try {
    return JSON.parse(result.stdout ?? "");
  } catch {
    return null;
  }
}

/** The reads of a real pull request, with the gh account of the caller's environment. */
export const realReads = (env = process.env) => ({
  readHead: (pr) => {
    const view = ghJson(["pr", "view", String(pr), "--json", "headRefOid"], env);
    return typeof view?.headRefOid === "string" ? view.headRefOid : null;
  },
  readChecks: (pr) => {
    const list = ghJson(["pr", "checks", String(pr), "--json", "name,state,bucket,link"], env);
    return Array.isArray(list) ? list : null;
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
});

const positive = (text, flag) => {
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} must be a positive number, got ${text}`);
  return value;
};

/** `qc ci-wait`. @returns the exit code of the outcome */
export async function runCiWait(argv, { reads = realReads(), say = (line) => console.log(line) } = {}) {
  let pr;
  let limits;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { max: { type: "string" }, queued: { type: "string" }, "first-wait": { type: "string" }, interval: { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length !== 1 || !/^[1-9]\d*$/.test(positionals[0])) throw new Error("name one pull request number");
    pr = Number(positionals[0]);
    limits = {
      max: positive(values.max ?? DEFAULTS.max, "--max"),
      queued: positive(values.queued ?? DEFAULTS.queued, "--queued"),
      firstWait: positive(values["first-wait"] ?? DEFAULTS.firstWait, "--first-wait"),
      interval: positive(values.interval ?? DEFAULTS.interval, "--interval"),
    };
  } catch (error) {
    say(`qc ci-wait: ${error.message}\n\n${USAGE}`);
    return EXIT.usage;
  }
  const outcome = await ciWait(pr, limits, reads);
  say(`qc ci-wait: PR ${pr} head ${short(outcome.head)} -> ${outcome.why} after ${outcome.minutes} min`);
  for (const entry of outcome.checks) say(`${entry.bucket}  ${entry.name}  ${entry.link ?? ""}`);
  const counts = {};
  for (const entry of outcome.all) counts[entry.bucket] = (counts[entry.bucket] ?? 0) + 1;
  say(`checks: ${Object.entries(counts).map(([bucket, count]) => `${bucket} ${count}`).join(", ") || "none read"}`);
  return EXIT[outcome.why];
}
