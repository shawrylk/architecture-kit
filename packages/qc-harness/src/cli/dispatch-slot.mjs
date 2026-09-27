// The resource for the implementer slot: one folder per session under the OS temp folder, with one
// claim file and the settings of the claim. A stop reads those settings, since its cwd can hold no config.

import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claimFileOf, claimPath, releasePath } from "./edit-batch-state.mjs";

const fileSafe = (id) => String(id).replace(/[^A-Za-z0-9_.-]/g, "_");
const KEY = "implementer";
const SETTINGS_FILE = "settings.json";
const MINUTE_MS = 60_000;

/** The slot folder of one session. */
export const slotDirOf = (sessionId, tmp) => path.join(tmp, "architecture-kit", "dispatch", fileSafe(sessionId));

/** The claim file of the slot in one session folder. */
export const slotFileOf = (dir) => claimFileOf(dir, KEY);

function recordedSettings(dir) {
  try {
    const { implementerTypes, slotMinutes } = JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), "utf8"));
    return Array.isArray(implementerTypes) && slotMinutes > 0 ? { implementerTypes, slotMinutes } : null;
  } catch {
    return null;
  }
}

/**
 * Claims the slot through an exclusive create, so two dispatches in one block cannot both win.
 * @returns null when this call holds the slot, or the holder's times and file; throws on a file system error
 */
export function claimSlot(dir, settings, now) {
  const ttlMs = settings.slotMinutes * MINUTE_MS;
  const slotFile = slotFileOf(dir);
  for (;;) {
    if (claimPath(dir, KEY, now, ttlMs)) {
      const { implementerTypes, slotMinutes } = settings;
      writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ implementerTypes, slotMinutes }));
      return null;
    }
    let claimedMs;
    try {
      claimedMs = statSync(slotFile).mtimeMs;
    } catch (error) {
      // The holder stopped between the claim and this read, so the slot is free again.
      if (error.code === "ENOENT") continue;
      throw error;
    }
    return { claimedAt: new Date(claimedMs), expiresAt: new Date(claimedMs + ttlMs), slotFile };
  }
}

/** Claims a free slot for an implementer that starts, as a resumed one does. A start cannot refuse, so it never waits. */
export function reclaimSlot(dir, agentType, now) {
  const settings = recordedSettings(dir);
  if (settings?.implementerTypes.includes(agentType)) claimPath(dir, KEY, now, settings.slotMinutes * MINUTE_MS);
}

/** Frees the slot when an implementer stops. @returns true when the stopped agent is an implementer */
export function releaseSlot(dir, agentType) {
  const settings = recordedSettings(dir);
  if (!settings?.implementerTypes.includes(agentType)) return false;
  releasePath(dir, KEY);
  return true;
}
