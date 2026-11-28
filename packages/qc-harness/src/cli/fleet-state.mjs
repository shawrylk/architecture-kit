import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { commonDirOf } from "./ledger.mjs";

const FILES = ["election", "proposal", "work", "assignments", "questions", "seen", "queue", "outbox", "dead", "peers", "node", "plans", "answers", "said", "inbox", "watched", "github", "jobs", "jobs-local"];

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
    if (error.code === "ENOENT") return ["queue", "outbox", "dead", "inbox"].includes(name) ? [] : {};
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

/** Prefer the highest observed term, then receipt order within that term. */
export function latestLeader(peers, minimum = 1) {
  const highest = Math.max(minimum, ...Object.values(peers).map(peer => peer.term ?? 1));
  return Object.values(peers).filter(peer => peer.leader === true && (peer.term ?? 1) >= highest && Number.isFinite(peer.time))
    .sort((a, b) => b.time - a.time)[0];
}

export const validTerm = term => Number.isSafeInteger(term) && term > 0;
export const livePeer = (peer, now) => Number.isFinite(peer?.time) && now - peer.time >= 0 && now - peer.time < 90_000;
export function highestTerm(root, node = readState(root, "node")) {
  return Math.max(1, readState(root, "election").highest ?? 1, node.term ?? 1,
    ...Object.values(readState(root, "peers")).map(peer => peer.term ?? 1));
}
export function leaderDead(root, now) {
  const election = readState(root, "election");
  const times = Object.values(readState(root, "peers")).filter(peer => peer.leader).map(peer => peer.time).filter(Number.isFinite);
  const last = Math.max(election.lastLeaderAt ?? election.started ?? (times.length ? -Infinity : now), ...times);
  return now - last >= 90_000;
}
export function leaderCandidate(root, fleet, now) {
  const peers = readState(root, "peers");
  return (fleet.leaders ?? fleet.nodes.map(node => node.id)).find(id => id === fleet.self ||
    (fleet.nodes.some(node => node.id === id && node.active !== false) && livePeer(peers[id], now)));
}
