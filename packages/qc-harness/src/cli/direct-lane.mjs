// The branch that decides the direct lane of `swarm.direct`: a small fix that the main session edits and merges
// without the subagent workflow. The controller guard and the merge guard ask it. Every unknown fails closed.

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILE, directDefaults, load, merge } from "../config.mjs";
import { pathMatcher } from "../glob.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { branchesAt, gitOut, gitOutWithin } from "./git-read.mjs";
import { latestVerdictFor, shaMatches } from "./ledger.mjs";

const KEY = "swarm.direct";
const DIRECT_KEYS = Object.keys(directDefaults);
const KINDS = ["task", "branch"];
const GITLINK_MODE = "160000";
const SNIFF_BYTES = 8_000;
const MAX_TEXT_BYTES = 1_000_000;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const PR_BASE = "the PR base";
// Under the 10 s timeout of a PreToolUse hook, for all git and gh reads of one call: a hook that times out lets its call run.
export const LANE_BUDGET_MS = 6_000;

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

/** The lines one edit adds or removes in its own text. A Write or a NotebookEdit also replaces the old text, which `editLane` adds. */
export function pendingLines(toolName, input = {}) {
  if (toolName === "Edit") return lineCount(input.old_string) + lineCount(input.new_string);
  if (toolName === "MultiEdit") return (input.edits ?? []).reduce((sum, one) => sum + lineCount(one?.old_string) + lineCount(one?.new_string), 0);
  if (toolName === "Write") return lineCount(input.content);
  if (toolName === "NotebookEdit") return lineCount(input.new_source);
  return 0;
}

/** A `gitOut` that shares one deadline, so the whole lane ends inside the hook's timeout. `late()` says it ran out. */
function gitBy(budgetMs) {
  const deadline = Date.now() + budgetMs;
  const read = (cwd, ...args) => {
    const left = deadline - Date.now();
    return left > 0 ? gitOutWithin(left, cwd, ...args) : null;
  };
  read.late = () => Date.now() >= deadline;
  return read;
}

const gitFailed = (git, what) => (git.late?.() ? `git ran past the ${LANE_BUDGET_MS} ms budget of the lane` : what);

/**
 * The limits of `swarm.direct` in `qc.config.json` at the commit `base`, read through `git`. A branch cannot loosen its own
 * limits, so the lane never reads the checkout's file. `label` names the base in a problem.
 * @returns `{ direct }`, or `{ problem }` naming why the lane is closed.
 */
function directAtBase(root, base, git, label = base) {
  const text = git(root, "show", `${base}:${CONFIG_FILE}`);
  if (text === null) return { problem: gitFailed(git, `git cannot read ${CONFIG_FILE} at ${label}`) };
  try {
    const config = JSON.parse(text);
    if (config === null || typeof config !== "object" || Array.isArray(config)) return { problem: `${CONFIG_FILE} at ${label} is not a JSON object` };
    const { swarm } = config;
    if (swarm !== undefined && (swarm === null || typeof swarm !== "object" || Array.isArray(swarm))) {
      return { problem: `swarm in ${CONFIG_FILE} at ${label} must be an object, got ${JSON.stringify(swarm)}` };
    }
    const direct = directSettings(swarm);
    return direct ? { direct } : { problem: `${KEY} is false at ${label}` };
  } catch (error) {
    return { problem: error instanceof SyntaxError ? `${CONFIG_FILE} at ${label} is not JSON` : error.message };
  }
}

// The checkout also sets `worktree.base` and `swarm.isolation.protectedBranches`, so a branch that edits the file could point `base` at looser settings.
const touchesConfig = (changes) => [...changes.keys()].some((file) => file.toLowerCase() === CONFIG_FILE);
const CONFIG_PROBLEM = `${CONFIG_FILE} changes on the branch, so it runs the subagent workflow`;

function startsWithNul(file) {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    return buffer.subarray(0, readSync(fd, buffer, 0, SNIFF_BYTES, 0)).includes(0);
  } finally {
    closeSync(fd);
  }
}

/** The lines of a text file, null for a binary or a large file, whose size the lane cannot judge, or undefined when it cannot be read. */
function fileLines(root, rel) {
  try {
    const file = path.join(root, rel);
    const stat = statSync(file);
    if (!stat.isFile()) return undefined;
    if (stat.size > MAX_TEXT_BYTES || startsWithNul(file)) return null;
    return lineCount(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The changed files since the commit `fork`, each with its changed lines. With `head`, the commit's changes;
 * without it, the working tree's, untracked files included. A binary file and a submodule have no size the lane
 * can judge, so they map to null. The read of untracked files stops once there are more than `maxFiles`.
 * @returns a Map from path to lines, or null when git cannot say.
 */
export function changesSince(root, fork, { head = null, maxFiles = Infinity, git = gitOut } = {}) {
  const out = git(root, "diff", "--raw", "--numstat", "--no-renames", "-z", fork, ...(head ? [head] : []));
  if (out === null) return null;
  const changes = new Map();
  const gitlinks = new Set();
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field === "") continue;
    if (field.startsWith(":")) {
      const [oldMode, newMode] = field.slice(1).split(" ");
      if (oldMode === GITLINK_MODE || newMode === GITLINK_MODE) gitlinks.add(fields[i + 1]);
      i++;
      continue;
    }
    const [added, deleted, file] = field.split("\t");
    changes.set(file, added === "-" ? null : Number(added) + Number(deleted));
  }
  for (const file of gitlinks) changes.set(file, null);
  if (head) return changes;
  const others = git(root, "ls-files", "--others", "--exclude-standard", "-z");
  if (others === null) return null;
  for (const file of others.split("\0").filter(Boolean)) {
    if (changes.size > maxFiles) break;
    if (git.late?.()) return null;
    const lines = fileLines(root, file);
    if (lines === undefined) return null;
    changes.set(file, lines);
  }
  return changes;
}

const sizeOf = (changes) => ({ files: changes.size, lines: [...changes.values()].reduce((sum, lines) => sum + (lines ?? 0), 0) });

/** One line that states the size of the branch against the limits. */
export const sizeLine = ({ files, lines }, direct) => `${lines} of ${direct.maxLines} lines in ${files} of ${direct.maxFiles} files`;

/** @returns why `changes` leave the lane, or null when they fit. */
export function sizeProblem(changes, direct) {
  const excluded = pathMatcher(direct.excludes);
  const hit = [...changes.keys()].find((file) => excluded(file));
  if (hit !== undefined) return `${hit} matches ${KEY}.excludes`;
  const opaque = [...changes.keys()].find((file) => changes.get(file) === null);
  if (opaque !== undefined) return `${opaque} is a binary file, a large file, or a submodule, so the lane cannot judge its size`;
  const size = sizeOf(changes);
  if (size.files > direct.maxFiles || size.lines > direct.maxLines) return `the branch changes ${sizeLine(size, direct)}`;
  return null;
}

/**
 * Judges one main-session edit of `rel` in the checkout at `root`. The branch diff and the pending edit together
 * must fit the limits at `base`, on a branch that is not protected, and neither may touch `qc.config.json`.
 * @returns `{ problem }`, or `{ problem: null, size, direct }` when it fits.
 */
export function editLane({ root, base, protectedBranches, rel, toolName, input, budgetMs = LANE_BUDGET_MS }) {
  const git = gitBy(budgetMs);
  const branch = git(root, "branch", "--show-current");
  if (branch === null) return { problem: gitFailed(git, "git cannot name the checked-out branch") };
  if (branch === "") return { problem: "the checkout has a detached head" };
  if (protectedBranches.includes(branch)) return { problem: `${branch} is a protected branch, so start a branch for the fix` };
  const fork = git(root, "merge-base", base, "HEAD");
  if (!fork) return { problem: gitFailed(git, `git cannot diff the branch against ${base}`) };
  const settings = directAtBase(root, base, git);
  if (!settings.direct) return settings;
  const { direct } = settings;
  const changes = changesSince(root, fork, { maxFiles: direct.maxFiles, git });
  if (!changes) return { problem: gitFailed(git, `git cannot diff the branch against ${base}`) };
  const old = toolName === "Write" || toolName === "NotebookEdit" ? fileLines(root, rel) : undefined;
  const replaced = old === undefined ? 0 : old;
  const before = changes.has(rel) ? changes.get(rel) : 0;
  changes.set(rel, before === null || replaced === null ? null : before + replaced + pendingLines(toolName, input));
  if (touchesConfig(changes)) return { problem: CONFIG_PROBLEM };
  const problem = sizeProblem(changes, direct);
  return problem ? { problem } : { problem: null, size: sizeOf(changes), direct };
}

/**
 * Judges the merge of head `sha` with no review of the merge kind. A record belongs to the branch when it names
 * a commit of the branch, or the name of a local branch at `sha`, so an amend or a rebase cannot drop it.
 * The newest review on the branch must not ask for changes, and no implementer may have worked on it.
 * `baseOid` is the commit the PR merges into, as GitHub names it: the lane reads the limits at that commit and
 * measures the branch from its merge base with it, so no local ref decides. A change to `qc.config.json` closes the lane.
 * @returns `{ problem }`, or `{ problem: null, size, direct, review }` when the merge fits. `review` is the
 * APPROVED verdict that a path of `reviewPaths` needed, or null.
 */
export function mergeLane({ root, baseOid, protectedBranches = [], sha, records, budgetMs = LANE_BUDGET_MS }) {
  if (typeof baseOid !== "string" || !OBJECT_ID.test(baseOid)) return { problem: "gh returned no base commit for the PR, so the lane cannot tell what the PR merges into" };
  const git = gitBy(budgetMs);
  if (git(root, "cat-file", "-e", `${baseOid}^{commit}`) === null) {
    return { problem: gitFailed(git, `the PR base commit ${baseOid.slice(0, 12)} is not in this repository, so run \`git fetch\``) };
  }
  const fork = git(root, "merge-base", baseOid, sha);
  if (!fork) return { problem: gitFailed(git, `git cannot find the merge base of ${PR_BASE} and ${sha}`) };
  const settings = directAtBase(root, baseOid, git, PR_BASE);
  if (!settings.direct) return settings;
  const { direct } = settings;
  const history = git(root, "rev-list", `${fork}..${sha}`);
  const changes = history === null ? null : changesSince(root, fork, { head: sha, git });
  if (!changes) return { problem: gitFailed(git, `git cannot diff ${sha} against ${PR_BASE}`) };
  if (touchesConfig(changes)) return { problem: CONFIG_PROBLEM };
  const shas = history.split(/\r?\n/).filter(Boolean);
  if (shas.length === 0) return { problem: `${sha} has no commit past ${PR_BASE}, so the lane cannot measure what the PR merges` };
  const branches = branchesAt(root, sha, git);
  if (branches.length === 0) return { problem: gitFailed(git, `no local branch points at ${sha}, so the ledger cannot be tied to its branch`) };
  const guarded = branches.find((branch) => protectedBranches.includes(branch));
  if (guarded !== undefined) return { problem: `${sha} is the head of the protected branch ${guarded}` };
  const ours = (record) => branches.includes(record.branch) || shas.some((one) => shaMatches(record.sha ?? record.head, one));
  const latest = records.filter((record) => record.type === "verdict" && KINDS.includes(record.kind) && ours(record)).at(-1);
  if (latest && latest.verdict !== "APPROVED") return { problem: `the latest review on the branch, of ${latest.sha}, is ${latest.verdict}` };
  const committed = (record) => record.type === "stop" && record.role === "implementer" && typeof record.head === "string";
  const dispatched = (record) => record.type === "dispatch" && record.task === true;
  if (records.some((record) => (committed(record) || dispatched(record)) && ours(record))) {
    return { problem: "an implementer worked on the branch, so it runs the subagent workflow" };
  }
  const problem = sizeProblem(changes, direct);
  if (problem) return { problem };
  const reviewed = pathMatcher(direct.reviewPaths);
  const needsReview = [...changes.keys()].find((file) => reviewed(file));
  const approval = needsReview === undefined ? null : latestVerdictFor(records, sha, KINDS);
  if (needsReview !== undefined && approval?.verdict !== "APPROVED") {
    return { problem: `${needsReview} matches ${KEY}.reviewPaths, so dispatch the task reviewer (sdd-reviewer) on ${sha}` };
  }
  return { problem: null, size: sizeOf(changes), direct, review: approval };
}
