// `qc gate-slot -- <command>`: run a heavy local command only while one of the machine's gate slots is free.
// A claim records its process id and start; a claim whose process is gone, or that is too old, is freed.

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { commandLine, runInShell, splitAtDashes } from "./child-run.mjs";

export const USAGE = `qc gate-slot — share the machine's slots for heavy local commands

  qc gate-slot [--slots <n>] [--max-minutes <m>] -- <command...>
      wait for a free slot, run the command, and free the slot when the command ends
  qc gate-slot --status
      list each held slot: its process, its age, its folder, and its command

  Wrap the local check, a test run of more than one file, a browser test, a live database test,
  a commit, and a push. QC_GATE_SLOTS sets the count (3 by default); QC_GATE_SLOT_DIR, the folder.`;

export const DEFAULT_SLOTS = 3;
export const DEFAULT_MAX_MINUTES = 120;
const MINUTE_MS = 60_000;
const WAIT_MS = 20_000;
const SLOT_FILE = /^slot-(\d+)\.json$/;

/** The machine-wide folder of the gate slots. */
export const gateSlotDirOf = (env = process.env, tmp = os.tmpdir()) => env.QC_GATE_SLOT_DIR || path.join(tmp, "architecture-kit", "gate-slots");

/** True while a process with this id runs; a process this user may not signal still runs. */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Each claim in the folder, with its parsed holder, or a null holder for a file that does not parse. */
export function claimsIn(dir) {
  let names;
  try {
    names = readdirSync(dir).filter((name) => SLOT_FILE.test(name));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return names.map((name) => {
    const file = path.join(dir, name);
    let holder = null;
    let mtimeMs = null;
    try {
      holder = JSON.parse(readFileSync(file, "utf8"));
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      // The holder freed it between the listing and this read, or is still writing it.
    }
    return { file, index: Number(SLOT_FILE.exec(name)[1]), holder, mtimeMs };
  });
}

/** Removes each claim whose process is gone or that is older than the limit. A file that does not parse waits a minute. */
export function freeStale(dir, now, maxMinutes, alive = isAlive) {
  const freed = [];
  for (const claim of claimsIn(dir)) {
    const startedAt = Date.parse(claim.holder?.startedAt ?? "");
    const readable = claim.holder !== null && Number.isInteger(claim.holder.pid) && !Number.isNaN(startedAt);
    const stale = readable
      ? !alive(claim.holder.pid) || now - startedAt > maxMinutes * MINUTE_MS
      : claim.mtimeMs !== null && now - claim.mtimeMs > MINUTE_MS;
    if (stale) {
      rmSync(claim.file, { force: true });
      freed.push(claim);
    }
  }
  return freed;
}

/** Claims the first free slot below the count by an exclusive create. @returns the slot file, or null when all are held */
export function claimSlot(dir, count, holder) {
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const file = path.join(dir, `slot-${index}.json`);
    try {
      writeFileSync(file, JSON.stringify(holder), { flag: "wx" });
      return file;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  return null;
}

const positive = (text, flag) => {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer, got ${text}`);
  return value;
};

/** `qc gate-slot`. @returns the command's exit code, or 2 on a usage error */
export async function runGateSlot(argv, deps = {}) {
  const {
    env = process.env,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    run = runInShell,
    say = (line) => console.error(line),
    alive = isAlive,
    pid = process.pid,
  } = deps;
  const { flags, command } = splitAtDashes(argv);
  let values;
  let slots;
  let maxMinutes;
  try {
    ({ values } = parseArgs({ args: flags, options: { slots: { type: "string" }, "max-minutes": { type: "string" }, status: { type: "boolean" } }, strict: true }));
    slots = positive(values.slots ?? env.QC_GATE_SLOTS ?? String(DEFAULT_SLOTS), "--slots");
    maxMinutes = positive(values["max-minutes"] ?? String(DEFAULT_MAX_MINUTES), "--max-minutes");
    if (!values.status && command.length === 0) throw new Error("name the command after --");
  } catch (error) {
    say(`qc gate-slot: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  const dir = gateSlotDirOf(env);
  if (values.status) {
    const claims = claimsIn(dir);
    if (claims.length === 0) say(`no gate slot is held in ${dir}`);
    for (const { index, holder } of claims) {
      const age = holder ? `${Math.round((now() - Date.parse(holder.startedAt)) / MINUTE_MS)} min` : "unreadable";
      say(`slot-${index}  pid ${holder?.pid ?? "?"}  ${age}  ${holder?.cwd ?? ""}  ${holder?.command ?? ""}`);
    }
    return 0;
  }
  const line = commandLine(command);
  let file = null;
  let waited = false;
  while (file === null) {
    freeStale(dir, now(), maxMinutes, alive);
    file = claimSlot(dir, slots, { pid, startedAt: new Date(now()).toISOString(), cwd: process.cwd(), command: line });
    if (file !== null) break;
    if (!waited) say(`qc gate-slot: all ${slots} slots are held; waiting. \`qc gate-slot --status\` lists them.`);
    waited = true;
    await sleep(WAIT_MS);
  }
  try {
    return await run(line, env);
  } finally {
    rmSync(file, { force: true });
  }
}
