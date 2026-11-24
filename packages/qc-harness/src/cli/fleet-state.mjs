import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { commonDirOf } from "./ledger.mjs";

const FILES = ["assignments", "questions", "seen", "queue", "outbox", "dead", "peers", "node"];

/** State is private to git's shared directory, outside every worktree's tracked files. */
export function stateDir(root = process.cwd()) {
  const common = commonDirOf(root);
  if (!common) throw new Error("fleet state needs a git common dir");
  return path.join(common, "qc", "fleet");
}

function stateFile(root, name) {
  if (!FILES.includes(name)) throw new Error(`unknown fleet state file: ${name}`);
  return path.join(stateDir(root), `${name}.json`);
}

/** Missing state is empty; corrupt or unreadable state is an error. */
export function readState(root, name) {
  const file = stateFile(root, name);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return ["queue", "outbox", "dead"].includes(name) ? [] : {};
    throw error;
  }
}

/** Replace one complete snapshot, using a unique temporary file in the same directory. */
export function writeState(root, name, value) {
  const file = stateFile(root, name);
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new TypeError("fleet state value must serialize to JSON");
  const data = `${serialized}\n`;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, data, { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** Return a fresh ID-to-receipt-time snapshot retaining the inclusive ten-minute edge. */
export function pruneSeen(seen, now = Date.now()) {
  return Object.fromEntries(Object.entries(seen).filter(([, time]) => Number.isFinite(time) && now - time <= 600_000));
}
