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

const HOUR = 3_600_000;

/** A session id is a non-empty string; anything else is no session at all. */
export function sessionIdOf(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * The lease clock, the one place its age and lapse are computed. A lease binds only while it is fresh,
 * so an abandoned session cannot wedge a worktree; no holder, or a bad or future time, never binds.
 */
export function leaseState(lease, now, leaseHours) {
  const holder = sessionIdOf(lease?.sessionId);
  const written = Date.parse(lease?.updatedAt ?? "");
  const age = now - written;
  const lapsesAt = written + leaseHours * HOUR;
  const live = holder !== null && age >= 0 && now <= lapsesAt;
  return { holder, branch: lease?.branch ?? null, written, age, lapsesAt, live };
}

/** @returns the lease state when another session holds the worktree, or null. */
export function leaseHeldByAnother(lease, sessionId, now, leaseHours) {
  const caller = sessionIdOf(sessionId);
  const state = leaseState(lease, now, leaseHours);
  if (!caller || !state.live || state.holder === caller) return null;
  return state;
}

export function duration(ms) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.floor(ms / 1000)}s`;
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

export const timestamp = (ms) => new Date(ms).toISOString();

function heldRefusal(held, { branch, now, leaseFile, root, qc }) {
  const at = `"${root}"`;
  return (
    `Another agent (session ${held.holder}) is already working in this worktree on ` +
    `"${held.branch ?? branch}". Two agents on one branch lose each other's edits. ` +
    `Take your own: \`git worktree add ../<slug> -b <branch>\`. ` +
    `The lease is ${leaseFile}, written ${duration(held.age)} ago; it lapses at ` +
    `${timestamp(held.lapsesAt)}, in ${duration(held.lapsesAt - now)}. See it: \`${qc} lease status ${at}\`. ` +
    `Its holder releases it: \`${qc} lease release ${at} --session <id>\`. ` +
    `Releasing another session's lease is a person's call: \`${qc} lease release ${at} --force\`.`
  );
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
  return held ? heldRefusal(held, state) : null;
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
