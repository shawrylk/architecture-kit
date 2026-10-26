// The branch that reads `swarm.review` for the workflow checks. Every check is off until `swarm.dispatch`
// is on. A stop or a hand-back whose cwd holds no config reads the checkout its session remembered.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILE, defaults, load, merge, promotionDefaults, reviewDefaults } from "../config.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { configAtBase, directSettings } from "./direct-lane.mjs";
import { dispatchSettings } from "./dispatch.mjs";
import { fileSafe } from "./edit-batch-state.mjs";
import { ledgerFileOf } from "./ledger.mjs";
import { promotionBranchName } from "./promotion-branch.mjs";

const KEY = "swarm.review";
const MERGE_KINDS = ["branch", "task"];
const SWITCH_KEYS = ["oneBranchReview", "requireGreen", "requireBase", "productDecisions"];
const LIMIT_KEYS = ["roundFindings", "roundFiles"];
const REVIEW_KEYS = ["merge", "maxTaskCalls", "controllerPaths", "reviewerTypes", "plannerTypes", "codeReviewSkills", "promotion", ...SWITCH_KEYS, ...LIMIT_KEYS];
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
  const merged = merge(reviewDefaults, raw);
  let promotion = merged.promotion;
  if (promotion !== null) {
    if (typeof promotion !== "object" || Array.isArray(promotion)) throw wrong("promotion", promotion, "an object or null");
    const unknown = Object.keys(promotion).find((key) => !["integration", "release", "surfaces"].includes(key));
    if (unknown !== undefined) throw wrong(`promotion.${unknown}`, promotion[unknown], "absent; the keys are integration, release, surfaces");
    promotion = { ...promotionDefaults, ...promotion };
    for (const key of ["integration", "release"]) {
      if (typeof promotion[key] !== "string" || !promotion[key].trim()) throw wrong(`promotion.${key}`, promotion[key], "a non-empty branch name");
    }
    if (promotionBranchName(promotion.integration) === promotionBranchName(promotion.release)) throw wrong("promotion.release", promotion.release, "different from swarm.review.promotion.integration");
    if (!isNameList(promotion.surfaces) || promotion.surfaces.length === 0 || promotion.surfaces.some((glob) => !glob.trim())) {
      throw wrong("promotion.surfaces", promotion.surfaces, "a non-empty list of non-empty globs");
    }
  }
  const { merge: mergeKind, maxTaskCalls, controllerPaths, reviewerTypes, plannerTypes, codeReviewSkills } = merged;
  if (!MERGE_KINDS.includes(mergeKind)) throw wrong("merge", mergeKind, `one of ${MERGE_KINDS.join(", ")}`);
  if (!Number.isInteger(maxTaskCalls) || maxTaskCalls < 1) throw wrong("maxTaskCalls", maxTaskCalls, "a positive whole number");
  if (!isNameList(controllerPaths)) throw wrong("controllerPaths", controllerPaths, "a list of globs");
  for (const kind of MERGE_KINDS) {
    if (!isNameList(reviewerTypes?.[kind])) throw wrong(`reviewerTypes.${kind}`, reviewerTypes?.[kind], "a list of agent types");
  }
  if (!isNameList(plannerTypes)) throw wrong("plannerTypes", plannerTypes, "a list of agent types");
  if (!isNameList(codeReviewSkills)) throw wrong("codeReviewSkills", codeReviewSkills, "a list of skill names");
  for (const key of SWITCH_KEYS) {
    if (key === "requireGreen") {
      if (![true, false, "not-red"].includes(merged[key])) throw wrong(key, merged[key], 'true, false, or "not-red"');
      continue;
    }
    if (typeof merged[key] !== "boolean") throw wrong(key, merged[key], "true or false");
  }
  for (const key of LIMIT_KEYS) {
    if (!Number.isInteger(merged[key]) || merged[key] < 0) throw wrong(key, merged[key], "a whole number, 0 or more");
  }
  const enforcement = Object.fromEntries([...SWITCH_KEYS, ...LIMIT_KEYS].map((key) => [key, merged[key]]));
  return { merge: mergeKind, maxTaskCalls, controllerPaths, reviewerTypes, plannerTypes, codeReviewSkills, promotion, ...enforcement, implementerTypes: dispatch.implementerTypes };
}

/** The workflow branch reads the PR base through `git`, or the checkout when `git` is absent; null while dispatch is off. */
export function workflowAt(cwd, { baseOid, git } = {}) {
  const root = checkoutRootOf(cwd);
  if (!root) return null;
  let config;
  if (git) {
    const settings = configAtBase(root, baseOid, git, "the PR base");
    if (settings.problem) throw new Error(settings.problem);
    if (settings.config === null) return null;
    config = merge(defaults, settings.config);
  } else {
    if (!existsSync(path.join(root, CONFIG_FILE))) return null;
    config = load(root);
  }
  const review = reviewSettings(config.swarm);
  const ledger = review ? ledgerFileOf(root) : null;
  if (!review || !ledger) return null;
  // A wrong `swarm.direct` closes the lane only: the guards that read this workflow keep their checks.
  let direct = null;
  let directProblem = null;
  try {
    direct = directSettings(config.swarm);
    if (git && existsSync(path.join(root, CONFIG_FILE)) && !directSettings(load(root).swarm)) direct = null;
  } catch (error) {
    direct = null;
    directProblem = error.message;
  }
  return {
    root,
    ledger,
    review,
    direct,
    directProblem,
    base: config.worktree?.base ?? "origin/main",
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
