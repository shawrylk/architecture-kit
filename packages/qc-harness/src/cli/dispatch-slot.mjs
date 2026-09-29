// The resource for the implementer slots: one folder per session under the OS temp folder, with
// `implementerSlots` fixed slot files, `slot-0.claim` and up, and the settings of the claims. A stop reads
// those settings, since its cwd can hold no config.
//
// A slot file is made by an exclusive create and holds its holder's id. The Agent call does not know the new
// agent's id, so a dispatch holds `pending:<tool_use_id>`. The agent's start rewrites the slot it finds
// pending to `agent:<agent_id>`, and its stop removes the slot that holds its own id.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileSafe } from "./edit-batch-state.mjs";

const SETTINGS_FILE = "settings.json";
const MINUTE_MS = 60_000;
const PENDING = "pending:";
const AGENT = "agent:";
const SLOT_FILE = /^slot-(\d+)\.claim$/;

/** The slot folder of one session. */
export const slotDirOf = (sessionId, tmp) => path.join(tmp, "architecture-kit", "dispatch", fileSafe(sessionId));

const slotFileOf = (dir, index) => path.join(dir, `slot-${index}.claim`);

function recordedSettings(dir) {
  try {
    const { implementerTypes, slotMinutes, implementerSlots = 1 } = JSON.parse(
      readFileSync(path.join(dir, SETTINGS_FILE), "utf8"),
    );
    const valid = Array.isArray(implementerTypes) && slotMinutes > 0 && Number.isInteger(implementerSlots) && implementerSlots > 0;
    return valid ? { implementerTypes, slotMinutes, implementerSlots } : null;
  } catch {
    return null;
  }
}

const mtimeOf = (file) => {
  try {
    return statSync(file).mtimeMs;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

/** Deletes each slot file older than the lifetime. A file that another hook removed first is already gone. */
function expireSlots(dir, ttlMs, now) {
  let names;
  try {
    names = readdirSync(dir).filter((name) => SLOT_FILE.test(name));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    const claimedMs = mtimeOf(file);
    // The second read narrows the window in which a takeover by another hook is deleted.
    if (claimedMs !== null && now - claimedMs >= ttlMs && now - (mtimeOf(file) ?? now) >= ttlMs) rmSync(file, { force: true });
  }
}

/** The live slot files, oldest first, with the holder each holds. A file made but not yet written holds a pending claim. */
function slotsOf(dir) {
  let names;
  try {
    names = readdirSync(dir).filter((name) => SLOT_FILE.test(name));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const slots = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let held;
    let claimedMs;
    try {
      claimedMs = statSync(file).mtimeMs;
      held = readFileSync(file, "utf8");
    } catch {
      continue; // The holder stopped between the listing and this read.
    }
    const kind = held.startsWith(AGENT) ? AGENT : PENDING;
    const id = held.startsWith(kind) ? held.slice(kind.length) : held;
    slots.push({ file, index: Number(SLOT_FILE.exec(name)[1]), kind, id, held, claimedMs });
  }
  return slots.sort((a, b) => a.claimedMs - b.claimedMs || a.index - b.index);
}

/**
 * Creates one slot file through an exclusive create, which leaves an existing file as it is.
 * @returns true when this call made the file
 */
function createSlot(dir, index, held) {
  for (;;) {
    try {
      writeFileSync(slotFileOf(dir, index), held, { flag: "wx" });
      return true;
    } catch (error) {
      if (error.code === "ENOENT") {
        mkdirSync(dir, { recursive: true });
        continue;
      }
      if (error.code === "EEXIST") return false;
      throw error;
    }
  }
}

/** The first free slot below the limit takes the claim. @returns the slot's index, or -1 when every slot is held */
function takeFreeSlot(dir, limit, held) {
  for (let index = 0; index < limit; index += 1) if (createSlot(dir, index, held)) return index;
  return -1;
}

/** The slot that fills the limit and frees first, with the times the refusal states, and the holders it names. */
function refusalOf(slots, ttlMs, limit) {
  const [first] = slots;
  return {
    claimedAt: new Date(first.claimedMs),
    expiresAt: new Date(first.claimedMs + ttlMs),
    slotFile: first.file,
    limit,
    holders: slots.map((slot) => ({ id: slot.id, file: slot.file, claimedAt: new Date(slot.claimedMs) })),
  };
}

/**
 * Claims a slot for one holder. Each slot is an exclusive create, so no parallel block passes the limit.
 * @param holderId the dispatch's `tool_use_id`; a random id when the call carries none
 * @returns null when this call holds a slot, or the holders that fill the limit; throws on a file system error
 */
export function claimSlot(dir, settings, now, holderId = randomUUID()) {
  const ttlMs = settings.slotMinutes * MINUTE_MS;
  const limit = settings.implementerSlots ?? 1;
  const held = `${PENDING}${holderId}`;
  expireSlots(dir, ttlMs, now);
  if (slotsOf(dir).some((slot) => slot.held === held)) return null;
  const index = takeFreeSlot(dir, limit, held);
  if (index < 0) {
    const slots = slotsOf(dir);
    // Every holder stopped between the create and this read, so a slot is free again.
    return slots.length === 0 ? claimSlot(dir, settings, now, holderId) : refusalOf(slots, ttlMs, limit);
  }
  const { implementerTypes, slotMinutes } = settings;
  try {
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ implementerTypes, slotMinutes, implementerSlots: limit }));
  } catch (error) {
    // A claim with no settings is freed by no stop, so it would hold the slot until it expires.
    rmSync(slotFileOf(dir, index), { force: true });
    throw error;
  }
  return null;
}

/**
 * Binds a starting implementer to a slot. It rewrites one waiting dispatch claim, which counts once, and a
 * resumed implementer with none waiting takes a free slot. A start cannot refuse, so it never waits.
 */
export function reclaimSlot(dir, agentType, now, agentId = randomUUID()) {
  const settings = recordedSettings(dir);
  if (!settings?.implementerTypes.includes(agentType)) return;
  expireSlots(dir, settings.slotMinutes * MINUTE_MS, now);
  const held = `${AGENT}${agentId}`;
  const slots = slotsOf(dir);
  if (slots.some((slot) => slot.held === held)) return;
  const waiting = slots.find((slot) => slot.kind === PENDING);
  if (waiting) writeFileSync(waiting.file, held);
  else takeFreeSlot(dir, settings.implementerSlots, held);
}

/**
 * Frees the slot of a stopped implementer: the one that holds its own id, or when it holds none, one waiting slot.
 * @returns true when the stopped agent is an implementer
 */
export function releaseSlot(dir, agentType, agentId = "", now = Date.now()) {
  const settings = recordedSettings(dir);
  if (!settings?.implementerTypes.includes(agentType)) return false;
  expireSlots(dir, settings.slotMinutes * MINUTE_MS, now);
  const slots = slotsOf(dir);
  const own = agentId === "" ? undefined : slots.find((slot) => slot.held === `${AGENT}${agentId}`);
  const victim = own ?? slots.find((slot) => slot.kind === PENDING) ?? (agentId === "" ? slots[0] : undefined);
  if (victim) rmSync(victim.file, { force: true });
  return true;
}
