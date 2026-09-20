// Enforces swarm.md's isolation rule: an agent that generates code works in its own worktree, on
// its own branch. Two agents editing one branch is the failure this exists to prevent, and it has
// two shapes -- editing straight onto the trunk, and two sessions sharing one working directory.
// Git already refuses to check one branch out into two worktrees, so it covers neither shape.
//
// Off by default, like every other opt-in in this plugin: a solo agent declares nothing and is
// never restricted. A repository turns it on in `qc.config.json` under `swarm.isolation`.

import path from "node:path";

export const OFF = "off";
export const BRANCH = "branch";
export const WORKTREE = "worktree";
const LEVELS = [OFF, BRANCH, WORKTREE];
const DEFAULT_PROTECTED = ["main", "master"];
const DEFAULT_LEASE_HOURS = 8;

/** @returns the normalised isolation settings, or throws naming the key a repository got wrong. */
export function isolationSettings(swarm = {}) {
  const raw = swarm.isolation ?? {};
  const require = raw.require ?? OFF;
  if (!LEVELS.includes(require)) {
    throw new Error(`swarm.isolation.require must be one of ${LEVELS.join(", ")}, got ${JSON.stringify(require)}`);
  }
  const leaseHours = raw.leaseHours ?? DEFAULT_LEASE_HOURS;
  if (typeof leaseHours !== "number" || !(leaseHours > 0)) {
    throw new Error(`swarm.isolation.leaseHours must be a positive number, got ${JSON.stringify(raw.leaseHours)}`);
  }
  return {
    require,
    protectedBranches: raw.protectedBranches ?? DEFAULT_PROTECTED,
    leaseHours,
    allow: raw.allow ?? [],
  };
}

/** A linked worktree has its own git dir; the primary's git dir is the common one. */
export function worktreeKind(gitDir, gitCommonDir) {
  return path.resolve(gitDir) === path.resolve(gitCommonDir) ? "primary" : "linked";
}

/** A lease is another agent's only while it is fresh -- an abandoned session must not wedge a worktree. */
export function leaseHeldByAnother(lease, sessionId, now, leaseHours) {
  if (!lease?.sessionId || !sessionId) return null;
  if (lease.sessionId === sessionId) return null;
  const age = now - Date.parse(lease.updatedAt ?? 0);
  if (!(age >= 0) || age > leaseHours * 3_600_000) return null;
  return lease;
}

/**
 * The whole decision, as data, so every branch of it is testable without a git checkout.
 * @returns a reason string to refuse the edit, or null to allow it.
 */
export function isolationRefusal(state) {
  const { settings, branch, kind, inSpecialOperation, lease, sessionId, now } = state;
  if (settings.require === OFF) return null;
  if (inSpecialOperation) return null;

  if (!branch) {
    return "HEAD is detached, so this edit belongs to no branch. Check out a work-order branch before generating code.";
  }
  if (settings.protectedBranches.includes(branch)) {
    return (
      `"${branch}" is a protected branch and an agent does not generate code on it. ` +
      `Create a work order's own branch first: \`git worktree add ../<slug> -b <branch>\`.`
    );
  }
  if (settings.require === WORKTREE && kind === "primary") {
    return (
      `This is the primary worktree, shared by every session that opens the repository. ` +
      `Give this work order its own: \`git worktree add ../<slug> -b ${branch}\` from a clean checkout.`
    );
  }
  const held = leaseHeldByAnother(lease, sessionId, now, settings.leaseHours);
  if (held) {
    return (
      `Another agent (session ${held.sessionId.slice(0, 8)}) is already working in this worktree on ` +
      `"${held.branch ?? branch}". Two agents on one branch lose each other's edits. ` +
      `Take your own: \`git worktree add ../<slug> -b <branch>\`.`
    );
  }
  return null;
}

export function denyOutput(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `swarm isolation: ${reason}`,
    },
  };
}
