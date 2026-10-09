// The checks of `swarm.review` that read a dispatch prompt and its branch: one branch review, a head that
// is green and holds the base tip, and a brief with product decisions. The task gate calls them.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gitOutWithin, isAncestor, remoteTip } from "./git-read.mjs";
import { shaMatches } from "./ledger.mjs";
import { commitLookup, nativePath } from "./workflow-place.mjs";

// Every read of a reviewer dispatch is capped, so the whole guard ends inside the Agent hook's 30 second limit.
// Worst case: head 2 + branch 2 + origin tip 8 + lookup 2 + ancestor 2 + CI (origin 1, gh 3) = 20 s.
export const READ_MS = 2_000;
const REMOTE_MS = 8_000;

const REVIEWED_LINE = /^[ \t]*Reviewed:[ \t]*([0-9a-f]{7,40})[ \t]*$/im;
const BRIEF_LINE = /^[ \t]*Brief:[ \t]*(\S.*?)[ \t]*$/im;
const QUOTES = /^["'`]|["'`]$/g;
const PRODUCT_HEADING = /^##[ \t]+Product decisions[ \t]*$/i;
const SECTION_END = /^#{1,2}[ \t]/;
const FINDING_LINE = /^[ \t]*\d+\.[ \t]/gm;
const URL_TEXT = /https?:\/\/\S+/gi;
const TOKEN_CHARS = /[^\w@~./\\-]+/;
const EXTENSION = /\.([A-Za-z][A-Za-z0-9]+)$/;
const KNOWN_EXTENSIONS = new Set(
  "mjs cjs js jsx ts tsx json md yml yaml sh sql css html cs py go rs toml txt xml csv".split(" "),
);

const short = (sha) => (typeof sha === "string" ? sha.slice(0, 7) : "(none)");
const pass = (note = null) => ({ refusal: null, note });
const refuse = (refusal) => ({ refusal, note: null });

/** The sha on a prompt's `Reviewed: <sha>` line, or null. */
export const reviewedShaOf = (prompt) => REVIEWED_LINE.exec(String(prompt ?? ""))?.[1] ?? null;

/** The real reads of the base check, each with its own time limit. */
export const defaultReads = {
  remoteTip: (cwd, remote, branch) => remoteTip(cwd, remote, branch, REMOTE_MS),
  lookup: (cwd, ref) => commitLookup(cwd, ref, { timeoutMs: READ_MS }),
  isAncestor: (cwd, ancestor, descendant) => isAncestor(cwd, ancestor, descendant, READ_MS),
};

/** The head of a checkout, or null when git cannot say within the time limit. */
export const headOf = (root) => gitOutWithin(READ_MS, root, "rev-parse", "HEAD");

/** The branch checked out at a checkout, or null. */
export const branchOfCheckout = (root) => gitOutWithin(READ_MS, root, "branch", "--show-current") || null;

/** The refusal of a reviewer whose worktree, branch, or head cannot be read: no check that needs them can run. */
export const unreadableRefusal = (type, why) =>
  `Task gate: the ${type} prompt does not name a checkout the gate can read (${why}). ` +
  "Add a line `Worktree: <path>` that names a worktree whose checked-out branch is the branch under review, then dispatch.";

function branchReviewRefusal({ records, branch, prompt }) {
  const last = records.findLast((record) => record.type === "verdict" && record.kind === "branch" && record.branch === branch);
  if (!last) return null;
  const named = reviewedShaOf(prompt);
  if (named === null) {
    return (
      `Task gate: ${branch} already has a branch review in the ledger (${short(last.sha)}), and a PR gets one. ` +
      `Send the incremental review: add a line \`Reviewed: ${short(last.sha)}\`, the last head a branch review named, and pass the delta diff ${short(last.sha)}..<head> in place of the whole branch.`
    );
  }
  const known = records.some((record) => record.type === "verdict" && record.kind === "branch" && record.branch === branch && shaMatches(record.sha, named));
  if (known) return null;
  return (
    `Task gate: \`Reviewed: ${short(named)}\` is no head a branch review of ${branch} named. ` +
    `Write the last head a branch review named: \`Reviewed: ${short(last.sha)}\`.`
  );
}

/** The remote and branch to ask for the tip of `base`: `origin/<branch>`, or a bare name on origin. Null for any other spelling. */
function remoteBranchOf(base) {
  const named = /^origin\/(.+)$/.exec(base);
  if (named) return named[1];
  return base.includes("/") ? null : base;
}

/**
 * Judges that `head` holds the tip of `base`. The tip is read from origin, or from the local ref when origin does not answer.
 * Only a tip that is known and missing refuses; a read that fails passes with a note.
 * @returns `{ refusal, note }`
 */
export function baseCheck({ root, base, head, reads = defaultReads }) {
  const remoteBranch = remoteBranchOf(base);
  let tip = remoteBranch === null ? null : reads.remoteTip(root, "origin", remoteBranch);
  let note = null;
  if (tip === null) {
    const local = reads.lookup(root, base);
    if (!local.sha) {
      const why = local.error ?? "the ref is unknown";
      return pass(`Task gate could not read the tip of ${base} (${why}), so the base check did not run.`);
    }
    tip = local.sha;
    note = `Task gate read the tip of ${base} from local ${base}, because origin did not answer; run \`git fetch\` to make the check current.`;
  } else {
    const found = reads.lookup(root, tip);
    if (found.error) return pass(`Task gate could not look up the tip of ${base} (${found.error}), so the base check did not run.`);
    if (!found.sha) {
      return refuse(
        `Task gate: the tip of ${base} (${short(tip)}) is not in this checkout. Run \`git fetch\`, then merge ${base} into the branch, then dispatch the review.`,
      );
    }
  }
  const contained = reads.isAncestor(root, tip, head);
  if (contained === false) {
    return refuse(
      `Task gate: the head ${short(head)} lacks the tip of ${base} (${short(tip)}): merge ${base} into the branch first. CI tests the merge ref, so a review of a head that lacks the tip judges a different commit.`,
    );
  }
  if (contained === null) return pass(`Task gate could not tell whether ${short(head)} holds the tip of ${base}, so the base check did not run.`);
  return pass(note);
}

/**
 * The reviewer checks, in cheap-first order: one branch review, the base tip, green CI.
 * `ciState(sha)` is `{ reason, unknown }`; `reads` answers the base check.
 * @returns `{ refusal, note }`
 */
export function reviewerCheck({ type, prompt, review, base, records, root, branch, head, ciState, reads = defaultReads }) {
  if (!branch) return refuse(unreadableRefusal(type, "git read no branch there: a detached head, or git did not answer"));
  if (!head) return refuse(unreadableRefusal(type, "git read no head there"));
  if (review.oneBranchReview && review.reviewerTypes.branch.includes(type)) {
    const refusal = branchReviewRefusal({ records, branch, prompt });
    if (refusal) return refuse(refusal);
  }
  const notes = [];
  if (review.requireBase) {
    const result = baseCheck({ root, base, head, reads });
    if (result.refusal) return result;
    if (result.note) notes.push(result.note);
  }
  if (review.requireGreen) {
    const state = ciState(head);
    if (state.reason) {
      return refuse(
        `Task gate: ${state.reason}. A review waits for green CI on the head, since a red head changes before it is reviewed. Wait for the run, or fix the failure, then dispatch the review.`,
      );
    }
    if (state.unknown) notes.push(`Task gate: CI on ${short(head)} is unknown: ${state.unknown}. The review proceeds.`);
  }
  return pass(notes.length > 0 ? notes.join(" ") : null);
}

/** The numbered findings of a brief: the lines that start with a number and a dot. */
export const countFindings = (text) => (String(text ?? "").match(FINDING_LINE) ?? []).length;

/** The distinct files a brief names: a path with a separator, or a name with a known extension. */
export function countFiles(text) {
  const files = new Set();
  for (const token of String(text ?? "").replace(URL_TEXT, " ").split(TOKEN_CHARS)) {
    const name = token.replace(/\.+$/, "");
    const extension = EXTENSION.exec(name)?.[1];
    if (extension === undefined) continue;
    if (/[\\/]/.test(name) || KNOWN_EXTENSIONS.has(extension.toLowerCase())) files.add(name.replaceAll("\\", "/"));
  }
  return files.size;
}

/** The path on a prompt's `Brief: <path>` line, without quotes, or null. */
export const briefPathOf = (prompt) => BRIEF_LINE.exec(String(prompt ?? ""))?.[1].replace(QUOTES, "") ?? null;

/** The text under a brief's `## Product decisions` heading, up to the next heading of level 1 or 2, trimmed. Null when the heading is absent. */
function productDecisionsOf(text) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((line) => PRODUCT_HEADING.test(line));
  if (at < 0) return null;
  const end = lines.findIndex((line, index) => index > at && SECTION_END.test(line));
  return lines.slice(at + 1, end < 0 ? lines.length : end).join("\n").trim();
}

const BRIEF_LINE_HINT = "Write the brief to a file and name its path on a prompt line `Brief: <path>`, then dispatch.";

/** Reads the file the prompt's `Brief:` line names. @returns `{ text, source }` or `{ refusal }`. */
function briefOf(prompt, dirs, exists, read) {
  const spelled = briefPathOf(prompt);
  if (spelled === null) return { refusal: `Task gate: the implementer prompt has no \`Brief: <path>\` line. ${BRIEF_LINE_HINT}` };
  const file = dirs.map((dir) => path.resolve(dir, nativePath(spelled))).find((candidate) => exists(candidate));
  if (file === undefined) {
    return { refusal: `Task gate: the \`Brief: <path>\` line names ${spelled}, and no such file exists. ${BRIEF_LINE_HINT}` };
  }
  try {
    return { text: read(file), source: spelled };
  } catch (error) {
    return { refusal: `Task gate: the \`Brief: <path>\` line names ${spelled}, and the file cannot be read (${error.message}). ${BRIEF_LINE_HINT}` };
  }
}

/**
 * The implementer checks on a dispatch: its `Brief:` line names a file, the file holds a `## Product decisions` section
 * with text, and its round stays a size one implementer finishes. A missing brief or section refuses; a long brief only
 * warns. `dirs` resolve a relative brief path. With every brief check off, the brief is not read.
 * @returns `{ refusal, note }`
 */
export function briefCheck({ prompt, dirs, review, exists = existsSync, read = (file) => readFileSync(file, "utf8") }) {
  if (!review.productDecisions && review.roundFindings <= 0 && review.roundFiles <= 0) return pass();
  const brief = briefOf(prompt, dirs, exists, read);
  if (brief.refusal) return refuse(brief.refusal);
  const { text, source } = brief;
  const decisions = review.productDecisions ? productDecisionsOf(text) : undefined;
  if (decisions === null) {
    return refuse(
      `Task gate: the brief (${source}) has no \`## Product decisions\` heading. Ask the user the product questions first, in one question, ` +
        "and record the answers under `## Product decisions` in the brief; write the rulings that bind the task, or `none` with the reason. Then dispatch.",
    );
  }
  if (decisions === "") {
    return refuse(
      `Task gate: the \`## Product decisions\` section of the brief (${source}) is empty. ` +
        "Write the rulings that bind the task under it, or `none` with the reason. Then dispatch.",
    );
  }
  const findings = review.roundFindings > 0 ? countFindings(text) : 0;
  const files = review.roundFiles > 0 ? countFiles(text) : 0;
  const parts = [];
  if (review.roundFindings > 0 && findings > review.roundFindings) {
    parts.push(`${findings} numbered findings, over swarm.review.roundFindings (${review.roundFindings})`);
  }
  if (review.roundFiles > 0 && files > review.roundFiles) parts.push(`${files} files, over swarm.review.roundFiles (${review.roundFiles})`);
  if (parts.length === 0) return pass();
  return pass(
    `Task gate: the brief (${source}) names ${parts.join(", and ")}. One implementer finishes a smaller round. ` +
      "Split it: parallel implementers on disjoint paths, sub-branches in separate worktrees, merged by the controller.",
  );
}
