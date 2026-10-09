// The checks of `swarm.review` that read a dispatch prompt and its branch: one branch review, a head that
// is green and holds the base tip, and a brief with product decisions. The task gate calls them.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { handoffPathOf } from "./handoff-note.mjs";
import { gitOutWithin, isAncestor, remoteTip } from "./git-read.mjs";
import { shaMatches } from "./ledger.mjs";
import { commitLookup, nativePath } from "./workflow-place.mjs";

// Every read of a reviewer dispatch is capped, so the whole guard ends inside the Agent hook's 30 second limit.
export const READ_MS = 2_000;
const REMOTE_MS = 2_000;

const REVIEWED_LINE = /^[ \t]*Reviewed:[ \t]*([0-9a-f]{7,40})[ \t]*$/im;
const PRODUCT_HEADING = /^##[ \t]+Product decisions[ \t]*$/im;
const MD_PATH = /[^\s"'`()<>|*?,;]+\.md(?!\w)/gi;
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

function branchReviewRefusal({ records, branch, prompt }) {
  if (!branch || reviewedShaOf(prompt) !== null) return null;
  const last = records.findLast((record) => record.type === "verdict" && record.kind === "branch" && record.branch === branch);
  if (!last) return null;
  return (
    `Task gate: ${branch} already has a branch review in the ledger (${short(last.sha)}), and a PR gets one. ` +
    `Send the incremental review: add a line \`Reviewed: ${short(last.sha)}\` to the prompt, and pass the delta diff ${short(last.sha)}..<head> in place of the whole branch.`
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
  if (review.oneBranchReview && review.reviewerTypes.branch.includes(type)) {
    const refusal = branchReviewRefusal({ records, branch, prompt });
    if (refusal) return refuse(refusal);
  }
  if (!head) return pass("Task gate read no head from the worktree, so the base and CI checks did not run.");
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

/** Every distinct `.md` path a prompt names, in order. */
export const briefPathsIn = (prompt) => [...new Set(String(prompt ?? "").match(MD_PATH) ?? [])];

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

/** The brief of a prompt: the first `.md` path that exists and reads, apart from the hand-off note, else the prompt itself. */
function briefOf(prompt, dirs, exists, read) {
  const handoff = handoffPathOf(prompt);
  for (const spelled of briefPathsIn(prompt)) {
    if (spelled === handoff) continue;
    const file = dirs.map((dir) => path.resolve(dir, nativePath(spelled))).find((candidate) => exists(candidate));
    if (file === undefined) continue;
    try {
      return { text: read(file), source: spelled };
    } catch {
      break;
    }
  }
  return { text: String(prompt ?? ""), source: "the prompt" };
}

/**
 * The implementer checks on a dispatch: its brief holds a `## Product decisions` heading, and its round stays a size
 * one implementer finishes. A missing heading refuses; a long brief only warns. `dirs` resolve a relative brief path.
 * @returns `{ refusal, note }`
 */
export function briefCheck({ prompt, dirs, review, exists = existsSync, read = (file) => readFileSync(file, "utf8") }) {
  const { text, source } = briefOf(prompt, dirs, exists, read);
  if (review.productDecisions && !PRODUCT_HEADING.test(text)) {
    return refuse(
      `Task gate: the brief (${source}) has no \`## Product decisions\` heading. Ask the user the product questions first, in one question, ` +
        "and record the answers under `## Product decisions` in the brief; write the rulings that bind the task, or `None` with the reason. Then dispatch.",
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
