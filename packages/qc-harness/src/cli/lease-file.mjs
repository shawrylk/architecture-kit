// The resource for the worktree lease: the one file that says which agent session holds a worktree.
// It lives in the worktree's own git dir, so it is never committed and goes away with the worktree.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const LEASE_FILE = "qc-agent-lease.json";

export const leaseFileOf = (gitDir) => path.join(gitDir, LEASE_FILE);

/** @returns the parsed lease, or null when there is no file or it does not parse. */
export function readLease(gitDir) {
  try {
    return JSON.parse(readFileSync(leaseFileOf(gitDir), "utf8"));
  } catch {
    return null;
  }
}

/** @param {string | null} sessionId already validated; null claims nothing. */
export function claimLease(gitDir, sessionId, branch, now = Date.now()) {
  if (!sessionId) return;
  try {
    const payload = { sessionId, branch, updatedAt: new Date(now).toISOString() };
    writeFileSync(leaseFileOf(gitDir), `${JSON.stringify(payload, null, 2)}\n`);
  } catch {
    // A read-only or absent git dir is not a reason to block an edit.
  }
}

export function removeLease(gitDir) {
  rmSync(leaseFileOf(gitDir), { force: true });
}
