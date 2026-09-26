// The resource for the edit batch guard: one folder per agent in one session, under the OS temp
// folder, with one empty claim file per path. A hash names the file, so it holds no path.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const fileSafe = (id) => String(id).replace(/[^A-Za-z0-9_.-]/g, "_");
const BATCH_AWARE = "batch-aware";

/** The batch folder of one agent in one session. */
export const batchDirOf = (sessionId, agentKey, tmp) =>
  path.join(tmp, "architecture-kit", "edit-batch", `${fileSafe(sessionId)}-${fileSafe(agentKey)}`);

const claimFileOf = (dir, key) => path.join(dir, `${createHash("sha256").update(key).digest("hex")}.claim`);

/**
 * Claims one path through an exclusive create, so two hooks that run at once cannot both win.
 * A claim older than `ttlMs` is a leftover and is taken over.
 * @returns true when this call holds the claim; throws on a file system error
 */
export function claimPath(dir, key, now, ttlMs) {
  const file = claimFileOf(dir, key);
  for (;;) {
    try {
      writeFileSync(file, "", { flag: "wx" });
      return true;
    } catch (error) {
      if (error.code === "ENOENT") {
        mkdirSync(dir, { recursive: true });
        continue;
      }
      if (error.code !== "EEXIST") throw error;
    }
    let claimedAt;
    try {
      claimedAt = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (now - claimedAt < ttlMs) return false;
    rmSync(file, { force: true });
  }
}

/** Ends one claim before the batch ends. */
export const releasePath = (dir, key) => rmSync(claimFileOf(dir, key), { force: true });

/** True once a batch event has reached this agent, so its client sends one after every batch. */
export const isBatchAware = (dir) => existsSync(path.join(dir, BATCH_AWARE));

/** Ends every claim of the batch, and records that this agent receives batch events. */
export function endBatch(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, BATCH_AWARE), "");
}
