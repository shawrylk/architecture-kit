// `qc watch`: block until the first event among the pull requests, Codex jobs and workflow runs it watches.
// The wait is a shell command, so it costs no model tokens, and its exit is the event.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { runGhResult } from "./gh-run.mjs";

const DEFAULT_MAX_MINUTES = 55;
const DEFAULT_INTERVAL_SECONDS = 60;
const QUEUED_LIMIT_MS = 15 * 60_000;
const CODEX_TAIL_BYTES = 2048;
const SHA_SUFFIX = /^(.+)@([0-9a-f]{7,40})$/i;
const FAILED_CONCLUSIONS = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const FAILED_STATES = new Set(["FAILURE", "ERROR"]);

export const EXIT = { PASSED: 0, BAD_INPUT: 1, TIMEOUT: 4, FAILED: 5, QUEUED: 6 };

const USAGE =
  "usage: qc watch [--pr <n>]... [--codex <wrapper.log>]... [--run <workflow>@<branch>[@<sha>]]... [--max <minutes>] [--repo <owner/name>] [--interval <seconds>]\n" +
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
      const at = value.indexOf("@");
      if (at < 1 || at === value.length - 1) throw new Error(`--run needs <workflow>@<branch>[@<sha>], got ${value}`);
      const rest = value.slice(at + 1);
      const pinned = SHA_SUFFIX.exec(rest);
      parsed.runs.push({ workflow: value.slice(0, at), branch: pinned ? pinned[1] : rest, sha: pinned?.[2] });
    } else if (flag === "--max") parsed.maxMinutes = positive(flag, value);
    else if (flag === "--interval") parsed.intervalSeconds = positive(flag, value);
    else parsed.repo = value;
  }
  if (parsed.prs.length + parsed.codex.length + parsed.runs.length === 0) throw new Error("name at least one item: --pr, --codex or --run");
  return parsed;
}

/**
 * PowerShell 5.1 writes `*>` as UTF-16LE with a BOM, so the first two bytes pick the decoder.
 * When the file is longer than 2 KB, the read starts one character early and the text up to the first
 * newline is dropped, so a line that the cut split never matches.
 * @returns the last 2 KB of a file as whole lines of text, or null when it cannot be read yet.
 */
function readTail(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const bom = Buffer.alloc(Math.min(size, 2));
    readSync(fd, bom, 0, bom.length, 0);
    const utf16 = bom.length === 2 && bom[0] === 0xff && bom[1] === 0xfe;
    const unit = utf16 ? 2 : 1;
    const cut = size > CODEX_TAIL_BYTES;
    let start = cut ? size - CODEX_TAIL_BYTES - unit : 0;
    if (utf16 && start % 2 === 1) start += 1;
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString(utf16 ? "utf16le" : "utf8");
    if (!cut) return text.replace(/^﻿/, "");
    const newline = text.indexOf("\n");
    return newline < 0 ? "" : text.slice(newline + 1);
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

/**
 * Watches one workflow on one branch. Only a run of the armed head counts: the head the branch has at each poll,
 * or the one that `@<sha>` pins. A run of an earlier head never fires.
 */
function runWatcher({ workflow, branch, sha }, { repo, gh }) {
  const headArgs = ["api", `repos/${repo ?? "{owner}/{repo}"}/commits/${branch}`, "--jq", ".sha"];
  const listArgs = ["run", "list", "--workflow", workflow, "--branch", branch, "--limit", "20", "--json", "status,conclusion,headSha", ...(repo ? ["-R", repo] : [])];
  return () => {
    const head = sha ?? gh(headArgs)?.trim();
    if (!head) return null;
    const latest = parseJson(gh(listArgs))?.find((run) => typeof run.headSha === "string" && run.headSha.startsWith(head.toLowerCase()) || run.headSha === head);
    if (!latest || latest.status !== "completed") return null;
    return latest.conclusion === "success"
      ? { state: "passed", detail: latest.headSha, code: EXIT.PASSED }
      : { state: "failed", detail: latest.headSha, code: EXIT.FAILED };
  };
}

/** @returns gh's stdout on exit 0; throws an Error with gh's message when gh fails, times out, or is missing. */
function readGh(args) {
  const result = runGhResult(args);
  if (result.status === 0) return result.stdout ?? "";
  const reason = (result.stderr ?? "").split(/\r?\n/).find((line) => line.trim()) ?? result.error?.message ?? `gh exited ${result.status}`;
  throw new Error(reason.trim());
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A gh error writes one `watch: gh failed: <first line>` line to stderr and the wait goes on. It is never an event.
 * @param deps `gh` returns stdout, null, or throws; `say`, `warn`, `now` and `sleep` replace the output and the clock, for a test.
 * @returns the exit code: 0 an item finished well, 4 the bound passed, 5 a check or run failed, 6 a job stayed queued.
 */
export async function runWatch(argv, { gh = readGh, say = console.log, warn = console.error, now = Date.now, sleep = realSleep } = {}) {
  let parsed;
  try {
    parsed = parseWatchArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    return EXIT.BAD_INPUT;
  }
  const read = (args) => {
    try {
      const out = gh(args);
      if (out === null) warn("watch: gh failed: no answer");
      return out;
    } catch (error) {
      warn(`watch: gh failed: ${String(error?.message ?? error).split(/\r?\n/)[0]}`);
      return null;
    }
  };
  const context = { repo: parsed.repo, gh: read, now };
  const watchers = [
    ...parsed.prs.map((number) => ({ item: `pr:${number}`, poll: pullRequestWatcher(number, context) })),
    ...parsed.codex.map((file) => ({ item: `codex:${file}`, poll: codexWatcher(file) })),
    ...parsed.runs.map((entry) => ({ item: `run:${entry.workflow}@${entry.branch}${entry.sha ? `@${entry.sha}` : ""}`, poll: runWatcher(entry, context) })),
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
