// `qc watch`: block until the first event among the pull requests, Codex jobs and workflow runs it watches.
// The wait is a shell command, so it costs no model tokens, and its exit is the event.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { runGh } from "./gh-run.mjs";

const DEFAULT_MAX_MINUTES = 55;
const DEFAULT_INTERVAL_SECONDS = 60;
const QUEUED_LIMIT_MS = 15 * 60_000;
const CODEX_TAIL_BYTES = 2048;
const FAILED_CONCLUSIONS = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const FAILED_STATES = new Set(["FAILURE", "ERROR"]);

export const EXIT = { PASSED: 0, BAD_INPUT: 1, TIMEOUT: 4, FAILED: 5, QUEUED: 6 };

const USAGE =
  "usage: qc watch [--pr <n>]... [--codex <wrapper.log>]... [--run <workflow>@<branch>]... [--max <minutes>] [--repo <owner/name>] [--interval <seconds>]\n" +
  "exit 0 the item finished well, 1 bad input, 4 the bound passed, 5 a check or run failed, 6 a job stayed queued past 15 minutes";

const positive = (flag, text) => {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer, got ${text}`);
  return value;
};

/** @returns the items to watch and the settings; throws an Error naming the bad flag. */
export function parseWatchArgs(argv) {
  const parsed = { prs: [], codex: [], runs: [], repo: undefined, maxMinutes: DEFAULT_MAX_MINUTES, intervalSeconds: DEFAULT_INTERVAL_SECONDS };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--pr", "--codex", "--run", "--max", "--repo", "--interval"].includes(flag)) throw new Error(`unknown argument ${flag}`);
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--pr") parsed.prs.push(positive(flag, value));
    else if (flag === "--codex") parsed.codex.push(path.resolve(value));
    else if (flag === "--run") {
      const at = value.lastIndexOf("@");
      if (at < 1 || at === value.length - 1) throw new Error(`--run needs <workflow>@<branch>, got ${value}`);
      parsed.runs.push({ workflow: value.slice(0, at), branch: value.slice(at + 1) });
    } else if (flag === "--max") parsed.maxMinutes = positive(flag, value);
    else if (flag === "--interval") parsed.intervalSeconds = positive(flag, value);
    else parsed.repo = value;
  }
  if (parsed.prs.length + parsed.codex.length + parsed.runs.length === 0) throw new Error("name at least one item: --pr, --codex or --run");
  return parsed;
}

/** @returns the last 2 KB of a file as text, or null when it cannot be read yet. */
function readTail(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, CODEX_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const parseJson = (text) => {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** @returns "failed", "queued", "pending", or "passed" for one rollup entry, a check run or a status context. */
function entryState(entry) {
  if (entry.__typename === "StatusContext" || entry.context !== undefined) {
    if (FAILED_STATES.has(entry.state)) return "failed";
    return entry.state === "SUCCESS" ? "passed" : "pending";
  }
  if (entry.status !== "COMPLETED") return entry.status === "QUEUED" ? "queued" : "pending";
  if (FAILED_CONCLUSIONS.has(entry.conclusion)) return "failed";
  return "passed";
}

/**
 * Watches one pull request. The queued timers belong to a head, so a new head starts them over.
 * @returns a function that polls once and answers `{ state, detail, code }` for an event, or null.
 */
function pullRequestWatcher(number, { repo, gh, now }) {
  let head = null;
  let queuedSince = new Map();
  const args = ["pr", "view", String(number), "--json", "headRefOid,statusCheckRollup", ...(repo ? ["-R", repo] : [])];
  return () => {
    const view = parseJson(gh(args));
    if (!view || !Array.isArray(view.statusCheckRollup)) return null;
    if (view.headRefOid !== head) {
      head = view.headRefOid;
      queuedSince = new Map();
    }
    const at = now();
    const states = view.statusCheckRollup.map((entry) => [entry.name ?? entry.context, entryState(entry)]);
    if (states.some(([, state]) => state === "failed")) return { state: "failed", detail: head, code: EXIT.FAILED };
    for (const [name] of [...queuedSince]) if (!states.some(([other, state]) => other === name && state === "queued")) queuedSince.delete(name);
    for (const [name, state] of states) if (state === "queued" && !queuedSince.has(name)) queuedSince.set(name, at);
    if ([...queuedSince.values()].some((since) => at - since > QUEUED_LIMIT_MS)) return { state: "queued", detail: head, code: EXIT.QUEUED };
    if (states.length > 0 && states.every(([, state]) => state === "passed")) return { state: "passed", detail: head, code: EXIT.PASSED };
    return null;
  };
}

function codexWatcher(file) {
  return () => {
    const tail = readTail(file);
    const line = tail?.split(/\r?\n/).reverse().find((text) => text.startsWith("exit "));
    return line === undefined ? null : { state: "exit", detail: line.slice("exit ".length).trim(), code: EXIT.PASSED };
  };
}

function runWatcher({ workflow, branch }, { repo, gh }) {
  const args = ["run", "list", "--workflow", workflow, "--branch", branch, "--limit", "1", "--json", "status,conclusion,headSha", ...(repo ? ["-R", repo] : [])];
  return () => {
    const latest = parseJson(gh(args))?.[0];
    if (!latest || latest.status !== "completed") return null;
    return latest.conclusion === "success"
      ? { state: "passed", detail: latest.headSha, code: EXIT.PASSED }
      : { state: "failed", detail: latest.headSha, code: EXIT.FAILED };
  };
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param deps `gh`, `say`, `now` and `sleep` replace the real reads, the output and the clock, for a test.
 * @returns the exit code: 0 an item finished well, 4 the bound passed, 5 a check or run failed, 6 a job stayed queued.
 */
export async function runWatch(argv, { gh = runGh, say = console.log, now = Date.now, sleep = realSleep } = {}) {
  let parsed;
  try {
    parsed = parseWatchArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    return EXIT.BAD_INPUT;
  }
  const context = { repo: parsed.repo, gh: (args) => gh(args), now };
  const watchers = [
    ...parsed.prs.map((number) => ({ item: `pr:${number}`, poll: pullRequestWatcher(number, context) })),
    ...parsed.codex.map((file) => ({ item: `codex:${file}`, poll: codexWatcher(file) })),
    ...parsed.runs.map((entry) => ({ item: `run:${entry.workflow}@${entry.branch}`, poll: runWatcher(entry, context) })),
  ];
  const deadline = now() + parsed.maxMinutes * 60_000;
  for (;;) {
    for (const { item, poll } of watchers) {
      const event = poll();
      if (event) {
        say(`EVENT ${item} ${event.state} ${event.detail}`);
        return event.code;
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      say("EVENT timeout");
      return EXIT.TIMEOUT;
    }
    await sleep(Math.min(parsed.intervalSeconds * 1000, remaining));
  }
}
