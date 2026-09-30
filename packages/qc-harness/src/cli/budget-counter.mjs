// The resource for the tool-call counters: one small JSON file per agent, under the OS temp folder.
// It holds no transcript and no tool input, only a number, and a lost file only restarts a count.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const fileSafe = (id) => String(id).replace(/[^A-Za-z0-9_.-]/g, "_");

/** The counter file of one agent in one session. */
export const counterFileOf = (sessionId, agentId, tmp) =>
  path.join(tmp, "architecture-kit", "budget", `${fileSafe(sessionId)}-${fileSafe(agentId)}.json`);

function readCount(file) {
  try {
    const { count } = JSON.parse(readFileSync(file, "utf8"));
    return Number.isInteger(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

/** Writes one small JSON payload through a rename; throws on a write error. */
function writeJson(file, payload) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, payload);
  } catch {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(temp, payload);
  }
  try {
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Adds one to the count and writes it through a rename. @returns the new count; throws on a write error. */
export function bumpCount(file, now = Date.now()) {
  const count = readCount(file) + 1;
  writeJson(file, JSON.stringify({ count, updatedAt: new Date(now).toISOString() }));
  return count;
}

/** The file that holds one agent's context-signal state: its first context, its estimate, and the last note. */
export const stateFileOf = (sessionId, agentId, tmp) =>
  path.join(tmp, "architecture-kit", "context", `${fileSafe(sessionId)}-${fileSafe(agentId)}.json`);

/** @returns the state, or {} for a missing or unreadable file. */
export function readState(file) {
  try {
    const state = JSON.parse(readFileSync(file, "utf8"));
    return state !== null && typeof state === "object" && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

/** Writes the state through a rename; throws on a write error. */
export const writeState = (file, state) => writeJson(file, JSON.stringify(state));
