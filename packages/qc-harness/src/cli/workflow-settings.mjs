// The branch that reads `swarm.review` for the workflow checks. Every check is off until `swarm.dispatch`
// is on. A stop or a hand-back whose cwd holds no config reads the checkout its session remembered.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILE, load, merge, reviewDefaults } from "../config.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { directSettings } from "./direct-lane.mjs";
import { dispatchSettings } from "./dispatch.mjs";
import { fileSafe } from "./edit-batch-state.mjs";
import { ledgerFileOf } from "./ledger.mjs";

const KEY = "swarm.review";
const MERGE_KINDS = ["branch", "task"];
const REVIEW_KEYS = ["merge", "maxTaskCalls", "controllerPaths", "reviewerTypes", "plannerTypes"];
const STATE_FILE = "state.json";

const isNameList = (value) => Array.isArray(value) && value.every((name) => typeof name === "string" && name !== "");
const wrong = (key, value, want) => new Error(`${KEY}.${key} in qc.config.json must be ${want}, got ${JSON.stringify(value)}`);

/** @returns the review settings, or null while `swarm.dispatch` is off; throws naming the key a repository got wrong. */
export function reviewSettings(swarm = {}) {
  const dispatch = dispatchSettings(swarm);
  if (!dispatch) return null;
  const raw = swarm.review ?? {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${KEY} in qc.config.json must be an object, got ${JSON.stringify(raw)}`);
  }
  const unknown = Object.keys(raw).find((key) => !REVIEW_KEYS.includes(key));
  if (unknown !== undefined) throw new Error(`${KEY}.${unknown} in qc.config.json is not a review setting; the keys are ${REVIEW_KEYS.join(", ")}`);
  const { merge: mergeKind, maxTaskCalls, controllerPaths, reviewerTypes, plannerTypes } = merge(reviewDefaults, raw);
  if (!MERGE_KINDS.includes(mergeKind)) throw wrong("merge", mergeKind, `one of ${MERGE_KINDS.join(", ")}`);
  if (!Number.isInteger(maxTaskCalls) || maxTaskCalls < 1) throw wrong("maxTaskCalls", maxTaskCalls, "a positive whole number");
  if (!isNameList(controllerPaths)) throw wrong("controllerPaths", controllerPaths, "a list of globs");
  for (const kind of MERGE_KINDS) {
    if (!isNameList(reviewerTypes?.[kind])) throw wrong(`reviewerTypes.${kind}`, reviewerTypes?.[kind], "a list of agent types");
  }
  if (!isNameList(plannerTypes)) throw wrong("plannerTypes", plannerTypes, "a list of agent types");
  return { merge: mergeKind, maxTaskCalls, controllerPaths, reviewerTypes, plannerTypes, implementerTypes: dispatch.implementerTypes };
}

/** @returns the workflow of the checkout that holds `cwd`, or null when it has no config or the checks are off. */
export function workflowAt(cwd) {
  const root = checkoutRootOf(cwd);
  if (!root || !existsSync(path.join(root, CONFIG_FILE))) return null;
  const config = load(root);
  const review = reviewSettings(config.swarm);
  const ledger = review ? ledgerFileOf(root) : null;
  if (!review || !ledger) return null;
  // A wrong `swarm.direct` closes the lane only: the guards that read this workflow keep their checks.
  let direct = null;
  let directProblem = null;
  try {
    direct = directSettings(config.swarm);
  } catch (error) {
    directProblem = error.message;
  }
  return {
    root,
    ledger,
    review,
    direct,
    directProblem,
    base: config.worktree.base,
    protectedBranches: config.swarm.isolation?.protectedBranches ?? [],
  };
}

/** The workflow folder of one session under the OS temp folder. */
export const sessionDirOf = (sessionId, tmp) => path.join(tmp, "architecture-kit", "workflow", fileSafe(sessionId));

/** Keeps the main session's checkout, so a stop or a hand-back in another cwd finds the same ledger. */
export function rememberSession(sessionId, root, tmp) {
  const dir = sessionDirOf(sessionId, tmp);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, STATE_FILE), JSON.stringify({ root }));
}

function rememberedRoot(sessionId, tmp) {
  try {
    const { root } = JSON.parse(readFileSync(path.join(sessionDirOf(sessionId, tmp), STATE_FILE), "utf8"));
    return typeof root === "string" && root !== "" ? root : null;
  } catch {
    return null;
  }
}

/** The workflow of one hook event: its own cwd's checkout first, then the checkout its session remembered. */
export function workflowOf(call, tmp) {
  const own = workflowAt(call.cwd ?? process.cwd());
  if (own) return own;
  const root = rememberedRoot(call.session_id ?? "session", tmp);
  return root ? workflowAt(root) : null;
}
