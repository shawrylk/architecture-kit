// The branch that decides the direct lane of `swarm.direct`: a small fix that the main session edits and merges
// without the subagent workflow. The controller guard and the merge guard ask it. Every unknown fails closed.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILE, directDefaults, load, merge } from "../config.mjs";
import { globMatcher } from "../glob.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { gitOut } from "./git-read.mjs";
import { latestVerdictFor, shaMatches } from "./ledger.mjs";

const KEY = "swarm.direct";
const DIRECT_KEYS = Object.keys(directDefaults);
const KINDS = ["task", "branch"];

const isGlobList = (value) => Array.isArray(value) && value.every((glob) => typeof glob === "string" && glob !== "");
const isCount = (value) => Number.isInteger(value) && value >= 1;
const wrong = (key, value, want) => new Error(`${KEY}.${key} in qc.config.json must be ${want}, got ${JSON.stringify(value)}`);

/** @returns the lane's limits, or null when `swarm.direct` is false; throws naming the key a repository got wrong. */
export function directSettings(swarm = {}) {
  const raw = swarm.direct ?? {};
  if (raw === false) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${KEY} in qc.config.json must be an object or false, got ${JSON.stringify(raw)}`);
  }
  const unknown = Object.keys(raw).find((key) => !DIRECT_KEYS.includes(key));
  if (unknown !== undefined) throw new Error(`${KEY}.${unknown} in qc.config.json is not a direct lane setting; the keys are ${DIRECT_KEYS.join(", ")}`);
  const settings = merge(directDefaults, raw);
  for (const key of ["maxLines", "maxFiles"]) if (!isCount(settings[key])) throw wrong(key, settings[key], "a positive whole number");
  for (const key of ["excludes", "reviewPaths"]) if (!isGlobList(settings[key])) throw wrong(key, settings[key], "a list of globs");
  return settings;
}

/** @returns the lane's limits of the checkout that holds `cwd`, or null when it has no config or the lane is off. */
export function directSettingsAt(cwd) {
  const root = checkoutRootOf(cwd);
  if (!root || !existsSync(path.join(root, CONFIG_FILE))) return null;
  return directSettings(load(root).swarm);
}

/** The lines of a text as git counts them: a last line with no newline still counts. */
export function lineCount(text) {
  if (typeof text !== "string" || text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** The most lines one edit can change. A Write counts every line it writes, so an Edit fits a small fix better. */
export function pendingLines(toolName, input = {}) {
  if (toolName === "Edit") return lineCount(input.old_string) + lineCount(input.new_string);
  if (toolName === "MultiEdit") return (input.edits ?? []).reduce((sum, one) => sum + lineCount(one?.old_string) + lineCount(one?.new_string), 0);
  if (toolName === "Write") return lineCount(input.content);
  if (toolName === "NotebookEdit") return lineCount(input.new_source);
  return 0;
}

function untrackedLines(root, rel) {
  try {
    return lineCount(readFileSync(path.join(root, rel), "utf8"));
  } catch {
    return null;
  }
}

/**
 * The changed files since the commit `fork`, each with its changed lines. With `head`, the commit's changes;
 * without it, the working tree's, untracked files included. A binary file counts as a file with no lines.
 * @returns a Map from path to lines, or null when git cannot say.
 */
export function changesSince(root, fork, head = null) {
  const out = gitOut(root, "diff", "--numstat", "--no-renames", "-z", fork, ...(head ? [head] : []));
  if (out === null) return null;
  const changes = new Map();
  for (const entry of out.split("\0").filter(Boolean)) {
    const [added, deleted, file] = entry.split("\t");
    changes.set(file, added === "-" ? 0 : Number(added) + Number(deleted));
  }
  if (head) return changes;
  const others = gitOut(root, "ls-files", "--others", "--exclude-standard", "-z");
  if (others === null) return null;
  for (const file of others.split("\0").filter(Boolean)) {
    const lines = untrackedLines(root, file);
    if (lines === null) return null;
    changes.set(file, lines);
  }
  return changes;
}

const sizeOf = (changes) => ({ files: changes.size, lines: [...changes.values()].reduce((sum, lines) => sum + lines, 0) });

/** One line that states the size of the branch against the limits. */
export const sizeLine = ({ files, lines }, direct) => `${lines} of ${direct.maxLines} lines in ${files} of ${direct.maxFiles} files`;

/** @returns why `changes` leave the lane, or null when they fit. */
export function sizeProblem(changes, direct) {
  const excluded = globMatcher(direct.excludes);
  const hit = [...changes.keys()].find((file) => excluded(file));
  if (hit !== undefined) return `${hit} matches ${KEY}.excludes`;
  const size = sizeOf(changes);
  if (size.files > direct.maxFiles || size.lines > direct.maxLines) return `the branch changes ${sizeLine(size, direct)}`;
  return null;
}

/**
 * Judges one main-session edit of `rel` in the checkout at `root`. The branch diff and the pending edit together
 * must fit, on a branch that is not protected. @returns `{ problem }`, or `{ problem: null, size }` when it fits.
 */
export function editLane({ root, base, direct, protectedBranches, rel, toolName, input }) {
  const branch = gitOut(root, "branch", "--show-current");
  if (!branch) return { problem: "the checkout has a detached head" };
  if (protectedBranches.includes(branch)) return { problem: `${branch} is a protected branch, so start a branch for the fix` };
  const fork = gitOut(root, "merge-base", base, "HEAD");
  const changes = fork ? changesSince(root, fork) : null;
  if (!changes) return { problem: `git cannot diff the branch against ${base}` };
  changes.set(rel, (changes.get(rel) ?? 0) + pendingLines(toolName, input));
  const problem = sizeProblem(changes, direct);
  return problem ? { problem } : { problem: null, size: sizeOf(changes) };
}

/** True when an implementer stopped at a commit between `fork` and `sha`: that branch runs the subagent workflow. */
function implementerWork(root, fork, sha, records) {
  const stops = records.filter((record) => record.type === "stop" && record.role === "implementer" && typeof record.head === "string");
  if (stops.length === 0) return false;
  const history = gitOut(root, "rev-list", `${fork}..${sha}`);
  if (history === null) return true;
  const shas = history.split(/\r?\n/).filter(Boolean);
  return stops.some((stop) => shas.some((one) => shaMatches(stop.head, one)));
}

/**
 * Judges the merge of head `sha` with no review of the merge kind. Any verdict that is not APPROVED on the head
 * keeps the lane shut. @returns `{ problem }`, or `{ problem: null, size }` when the merge fits.
 */
export function mergeLane({ root, base, direct, sha, records }) {
  const verdict = latestVerdictFor(records, sha, KINDS);
  if (verdict && verdict.verdict !== "APPROVED") return { problem: `the latest review of ${sha} is ${verdict.verdict}` };
  const fork = gitOut(root, "merge-base", base, sha);
  if (!fork) return { problem: `git cannot find the merge base of ${base} and ${sha}` };
  const changes = changesSince(root, fork, sha);
  if (!changes) return { problem: `git cannot diff ${sha} against ${base}` };
  if (implementerWork(root, fork, sha, records)) return { problem: "an implementer committed on the branch, so it runs the subagent workflow" };
  const problem = sizeProblem(changes, direct);
  if (problem) return { problem };
  const reviewed = globMatcher(direct.reviewPaths);
  const needsReview = [...changes.keys()].find((file) => reviewed(file));
  if (needsReview !== undefined && verdict?.verdict !== "APPROVED") {
    return { problem: `${needsReview} matches ${KEY}.reviewPaths, so dispatch the task reviewer (sdd-reviewer) on ${sha}` };
  }
  return { problem: null, size: sizeOf(changes) };
}
