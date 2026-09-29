// The resource for the implementer slots: one folder per session under the OS temp folder, with up to
// `implementerSlots` claim files, one per holder, and the settings of the claims. A stop reads those
// settings, since its cwd can hold no config.
//
// A dispatch claims for its own `tool_use_id`, since the Agent call does not know the new agent's id.
// The agent's start renames one such claim to its own id, and its stop frees that file.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileSafe } from "./edit-batch-state.mjs";

const SETTINGS_FILE = "settings.json";
const MINUTE_MS = 60_000;
const PENDING = "pending-";
const AGENT = "agent-";
const SUFFIX = ".claim";

/** The slot folder of one session. */
export const slotDirOf = (sessionId, tmp) => path.join(tmp, "architecture-kit", "dispatch", fileSafe(sessionId));

const claimName = (kind, id) => `${kind}${fileSafe(id)}${SUFFIX}`;

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

/**
 * The live claims of one folder, oldest first. A claim older than the lifetime is a leftover and is deleted.
 * @returns a list of { name, file, kind, id, claimedMs }
 */
function liveClaims(dir, ttlMs, now) {
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(SUFFIX));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const claims = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let claimedMs;
    try {
      claimedMs = statSync(file).mtimeMs;
    } catch {
      continue; // The holder stopped between the listing and this read.
    }
    if (now - claimedMs >= ttlMs) {
      rmSync(file, { force: true });
      continue;
    }
    const kind = name.startsWith(PENDING) ? PENDING : AGENT;
    claims.push({ name, file, kind, id: name.slice(kind.length, -SUFFIX.length), claimedMs });
  }
  return claims.sort((a, b) => a.claimedMs - b.claimedMs || a.name.localeCompare(b.name));
}

/** The claim that frees first, with the times the refusal states, and the holders it names. */
function refusalOf(claims, ttlMs, limit) {
  const [first] = claims;
  return {
    claimedAt: new Date(first.claimedMs),
    expiresAt: new Date(first.claimedMs + ttlMs),
    slotFile: first.file,
    limit,
    holders: claims.map((claim) => ({ id: claim.id, file: claim.file, claimedAt: new Date(claim.claimedMs) })),
  };
}

/**
 * Creates one claim file through an exclusive create, which leaves an existing file as it is.
 * @returns true when this call made the file
 */
function createClaim(dir, name) {
  const file = path.join(dir, name);
  for (;;) {
    try {
      writeFileSync(file, "", { flag: "wx" });
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

/**
 * Claims a slot for one holder through an exclusive create, so two dispatches in one block cannot lose a claim.
 * @param holderId the dispatch's `tool_use_id`; a random id when the call carries none
 * @returns null when this call holds a slot, or the holders that fill the limit; throws on a file system error
 */
export function claimSlot(dir, settings, now, holderId = randomUUID()) {
  const ttlMs = settings.slotMinutes * MINUTE_MS;
  const limit = settings.implementerSlots ?? 1;
  const name = claimName(PENDING, holderId);
  for (;;) {
    const claims = liveClaims(dir, ttlMs, now);
    if (claims.some((claim) => claim.name === name)) return null;
    if (claims.length >= limit) return refusalOf(claims, ttlMs, limit);
    if (!createClaim(dir, name)) continue;
    const { implementerTypes, slotMinutes } = settings;
    try {
      writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ implementerTypes, slotMinutes, implementerSlots: limit }));
    } catch (error) {
      // A claim with no settings is freed by no stop, so it would hold the slot until it expires.
      rmSync(path.join(dir, name), { force: true });
      throw error;
    }
    return null;
  }
}

/**
 * Binds a starting implementer to a slot. It takes over one waiting dispatch claim, which counts once,
 * and a resumed implementer with none waiting claims a free slot. A start cannot refuse, so it never waits.
 */
export function reclaimSlot(dir, agentType, now, agentId = randomUUID()) {
  const settings = recordedSettings(dir);
  if (!settings?.implementerTypes.includes(agentType)) return;
  const ttlMs = settings.slotMinutes * MINUTE_MS;
  const claims = liveClaims(dir, ttlMs, now);
  const own = claimName(AGENT, agentId);
  if (claims.some((claim) => claim.name === own)) return;
  for (const waiting of claims.filter((claim) => claim.kind === PENDING)) {
    try {
      renameSync(waiting.file, path.join(dir, own));
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error; // Another start took this claim first, so try the next.
    }
  }
  if (claims.length < settings.implementerSlots) createClaim(dir, own);
}

/**
 * Frees the claim of a stopped implementer: its own file, or when it has none, the oldest waiting claim.
 * @returns true when the stopped agent is an implementer
 */
export function releaseSlot(dir, agentType, agentId = "") {
  const settings = recordedSettings(dir);
  if (!settings?.implementerTypes.includes(agentType)) return false;
  const own = path.join(dir, claimName(AGENT, agentId));
  if (agentId !== "" && existsSync(own)) {
    rmSync(own, { force: true });
    return true;
  }
  const claims = liveClaims(dir, settings.slotMinutes * MINUTE_MS, Date.now());
  const victim = claims.find((claim) => claim.kind === PENDING) ?? (agentId === "" ? claims[0] : undefined);
  if (victim) rmSync(victim.file, { force: true });
  return true;
}
