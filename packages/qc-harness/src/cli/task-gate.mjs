// The branch that holds the main session to the task order: a review before the next implementer on a
// branch, and a fix round back to the implementer that wrote it. The dispatch guard calls it.

import os from "node:os";
import path from "node:path";
import { checkoutRootOf } from "./checkout-root.mjs";
import { ciNotGreen, ciState as readCiState } from "./ci-state.mjs";
import { typeOf } from "./dispatch.mjs";
import { handoffPathOf, resolveHandoff } from "./handoff-note.mjs";
import { gitOutWithin, linkedWorktrees, pathKey } from "./git-read.mjs";
import { appendRecord, latestVerdictFor, latestVerdictOn, readLedger, shaMatches } from "./ledger.mjs";
import { resolveNamedWorktree, workflowOfRepo, worktreeNamed } from "./workflow-place.mjs";
import { READ_MS, branchOfCheckout, briefCheck, defaultReads, headOf, reviewerCheck } from "./review-gate.mjs";
import { rememberSession, workflowAt } from "./workflow-settings.mjs";

export { worktreeNamed };

const NO_RESUME_LINE = /^[ \t]*NO-RESUME:[ \t]*(\S.*?)[ \t]*$/im;
const short = (sha) => (typeof sha === "string" ? sha.slice(0, 7) : "(none)");

/** The reason on a prompt's `NO-RESUME:` line, or null. */
export const noResumeReason = (prompt) => NO_RESUME_LINE.exec(prompt)?.[1] ?? null;

const fixRoundRefusal = (branch, sha, type) =>
  `Task gate: the last review on ${branch} (${short(sha)}) is CHANGES_REQUIRED, so the fix goes back to the implementer that wrote it. ` +
  "Resume it with SendMessage and the findings, then have the fix reviewed. " +
  `If a resume cannot work, such as a spent tool-call budget, add a line \`NO-RESUME: <reason>\` to the ${type} prompt; the ledger records the reason.`;

const unreviewedRefusal = (branch, stopHead, head) =>
  `Task gate: an implementer stopped on ${branch} at ${short(stopHead)}, and no review in the ledger names ${short(stopHead)} or a later commit. ` +
  `Dispatch the task reviewer on ${short(head)} first; its first line \`VERDICT: <APPROVED|CHANGES_REQUIRED> <sha>\` records the review. ` +
  `The review runs once CI on the head is green: when CI on ${short(stopHead)} has failed or still runs, the next implementer continues the task and this gate passes it. ` +
  `If that stop handed off, its report named \`HANDOFF: <note path>\`; the same line in the next implementer prompt continues the task. ` +
  `\`qc ledger ${branch}\` lists what is recorded.`;

const HISTORY_LIMIT = 5000;
// A read is capped, so the whole dispatch guard ends inside the Agent hook's 30 second limit.
const gitRead = (cwd, ...args) => gitOutWithin(READ_MS, cwd, ...args);

/**
 * The newest implementer stop in this branch's history that no later verdict on the branch covers,
 * or null. Older stops are ancestors of it, so its verdict covers them. Two git calls at most; a git error passes.
 */
function unreviewedImplementerStop({ records, branch, head, cwd, git }) {
  if (cwd === undefined) return null;
  const history = git(cwd, "rev-list", `--max-count=${HISTORY_LIMIT}`, head);
  if (history === null) return null;
  const inHistory = new Set(history.split(/\r?\n/).map((sha) => sha.toLowerCase()));
  const stopAt = records.findLastIndex(
    (record) =>
      record.type === "stop" && record.role === "implementer" && record.branch === branch && typeof record.head === "string" && inHistory.has(record.head.toLowerCase()),
  );
  if (stopAt < 0) return null;
  const stop = records[stopAt];
  const stopHead = stop.head;
  // A commit is reviewed once, wherever and whenever the verdict on it was written.
  if (records.some((record) => record.type === "verdict" && shaMatches(record.sha, stopHead))) return null;
  const later = records.slice(stopAt + 1).filter((record) => record.type === "verdict" && record.branch === branch && typeof record.sha === "string");
  if (later.length === 0 || shaMatches(stopHead, head)) return stop;
  const below = git(cwd, "rev-list", "--ancestry-path", `${stopHead}..${head}`);
  if (below === null) return null;
  const descendants = below.split(/\r?\n/).filter(Boolean);
  return later.some((verdict) => descendants.some((sha) => shaMatches(verdict.sha, sha))) ? null : stop;
}

/**
 * The newest implementer stop on `branch` when it left the note `handoff` and no verdict came after it, else null.
 * A later verdict on the branch, or one that names the stop's head, reviewed the stop, so its note is spent.
 */
export function continuedStop(records, branch, handoff) {
  if (handoff === null) return null;
  const stopAt = records.findLastIndex((record) => record.type === "stop" && record.role === "implementer" && record.branch === branch);
  const stop = records[stopAt];
  if (!stop || typeof stop.handoff !== "string" || pathKey(stop.handoff) !== pathKey(handoff)) return null;
  const reviewed = records.slice(stopAt + 1).some((record) => record.type === "verdict" && (record.branch === branch || shaMatches(record.sha, stop.head)));
  return reviewed ? null : stop;
}

/**
 * The task gate's answer for an implementer on `branch`: `refusal` is the reason it may not start now, or null.
 * `ciPass` is `{ sha, reason }` when an unreviewed stop head passes because CI on it is not green, else absent.
 * Only implementer commits need a review, so a controller commit after a reviewed head passes. `cwd` is any
 * checkout; `git` reads it, and `ci` answers why CI on a sha is not green, or null.
 */
export function gateVerdict({ records, branch, head, reason, type, cwd, git = gitRead, handoff = null, ci = (sha) => ciNotGreen(sha, cwd) }) {
  // A continuation of the newest stop's hand-off is the same task, so it is neither a fix round nor a new task.
  const continued = continuedStop(records, branch, handoff);
  const why = reason ?? (continued ? `continues the hand-off ${continued.handoff}` : null);
  const last = latestVerdictOn(records, branch);
  if (last?.verdict === "CHANGES_REQUIRED" && why === null) return { refusal: fixRoundRefusal(branch, last.sha, type) };
  const unreviewed = unreviewedImplementerStop({ records, branch, head, cwd, git });
  if (unreviewed && unreviewed !== continued) {
    // A head that CI failed changes before a review, so a review now would be spent on a commit that is replaced.
    const notGreen = ci(unreviewed.head);
    if (notGreen === null) return { refusal: unreviewedRefusal(branch, unreviewed.head, head) };
    return { refusal: null, ciPass: { sha: unreviewed.head, reason: notGreen } };
  }
  const current = latestVerdictFor(records, head, ["task", "branch"]);
  if (current?.verdict === "CHANGES_REQUIRED" && why === null) return { refusal: fixRoundRefusal(branch, current.sha, type) };
  return { refusal: null };
}

/** @returns the reason an implementer may not start on `branch` now, or null. `gateVerdict` has the inputs. */
export const gateRefusal = (input) => gateVerdict(input).refusal;

const pass = (workflow, record, note = null) => ({ refusal: null, workflow, record, note });
const refuse = (refusal) => ({ refusal, workflow: null, record: null, note: null });

const taskTypeIn = (type, review) =>
  review.implementerTypes.includes(type) || review.reviewerTypes.task.includes(type) || review.reviewerTypes.branch.includes(type);

/**
 * Judges one main-session Agent call. The repository of the worktree the prompt names decides, and the
 * repository of the cwd decides only when the prompt names none.
 * `ci`, `ciState`, and `reads` replace the CI and base reads, for a test.
 * @returns the refusal, or the record to write once the dispatch runs.
 */
export function judgeTask(call, tmp = os.tmpdir(), { ci, ciState, reads = defaultReads } = {}) {
  const cwd = call.cwd ?? process.cwd();
  let own;
  try {
    own = workflowAt(cwd);
  } catch (error) {
    return pass(null, null, `Task gate is off: ${error.message}`);
  }
  const session = call.session_id ?? "session";
  if (own) {
    try {
      rememberSession(session, own.root, tmp);
    } catch {
      // A busy temp folder costs only the fallback of a stop whose cwd holds no config.
    }
  }
  const input = call.tool_input ?? {};
  const type = typeOf(input);
  const prompt = String(input.prompt ?? "");
  const place = resolveNamedWorktree(prompt, own?.root ?? cwd);
  const named = place?.spelled ?? null;
  const base = { session, agentType: type, task: false, worktree: null, branch: null, head: null, resumeReason: null };
  let workflow = own;
  let abs = null;
  let root = null;
  if (place !== null && (!own || taskTypeIn(type, own.review))) {
    abs = place.abs;
    root = place.found ? checkoutRootOf(abs) : null;
    if (root) {
      try {
        workflow = workflowOfRepo(root, own);
      } catch (error) {
        return pass(null, null, `Task gate is off: ${error.message}`);
      }
      if (!workflow) {
        const note = `Task gate is off for ${root}: the repository has no swarm workflow, so this dispatch is not judged.`;
        return own && taskTypeIn(type, own.review) ? pass(null, null, note) : pass(null, null);
      }
    }
  }
  if (!workflow) return pass(null, null);
  let briefNote = null;
  if (workflow.review.implementerTypes.includes(type)) {
    const brief = briefCheck({ prompt, dirs: [cwd, ...(place ? [place.abs] : [])], review: workflow.review });
    if (brief.refusal) return refuse(brief.refusal);
    briefNote = brief.note;
  }
  if (named === null || !taskTypeIn(type, workflow.review)) return pass(workflow, base, briefNote);
  if (!workflow.review.implementerTypes.includes(type)) {
    // A reviewer waits for its checks. Its worktree tells the stop which branch the verdict belongs to.
    if (!root) return pass(workflow, base);
    const branch = branchOfCheckout(root);
    const head = headOf(root);
    const state = ciState ?? (ci ? (sha) => ({ reason: ci(sha), unknown: null }) : (sha) => readCiState(sha, root));
    let records = [];
    let ledgerNote = null;
    try {
      records = readLedger(workflow.ledger);
    } catch (error) {
      ledgerNote = `Task gate could not read the ledger (${error.message}), so the one-review check did not run.`;
    }
    const checked = reviewerCheck({ type, prompt, review: workflow.review, base: workflow.base, records, root, branch, head, ciState: state, reads });
    if (checked.refusal) return refuse(checked.refusal);
    return pass(workflow, { ...base, worktree: root, branch, head }, [ledgerNote, checked.note].filter(Boolean).join(" ") || null);
  }
  const key = pathKey(abs);
  const worktree = linkedWorktrees(workflow.root, READ_MS).find((entry) => pathKey(entry.path) === key);
  if (!worktree) {
    return refuse(`Task gate: the prompt names worktree "${named}", which is no linked worktree of this repository. Name the path \`git worktree list\` prints for the task's branch.`);
  }
  if (!worktree.branch) return refuse(`Task gate: the worktree "${named}" has a detached head. Check out the task's branch there, then dispatch.`);
  let records;
  try {
    records = readLedger(workflow.ledger);
  } catch (error) {
    return pass(null, null, `Task gate could not read the ledger (${error.message}), so this dispatch is not judged.`);
  }
  const reason = noResumeReason(prompt);
  const spelled = handoffPathOf(prompt);
  const handoff = spelled === null ? null : resolveHandoff(spelled, cwd);
  const { refusal, ciPass } = gateVerdict({ records, branch: worktree.branch, head: worktree.head, reason, type, cwd: workflow.root, handoff, ...(ci ? { ci } : {}) });
  if (refusal) return refuse(refusal);
  const continues = handoff ? { handoff } : {};
  const unreviewed = ciPass ? { ciPass } : {};
  return pass(workflow, { ...base, task: true, worktree: worktree.path, branch: worktree.branch, head: worktree.head, resumeReason: reason, ...continues, ...unreviewed }, briefNote);
}

/** Writes the dispatch record of a judged call. @returns a note for the session, or null. */
export function recordDispatch({ workflow, record, note }) {
  if (!workflow || !record) return note;
  try {
    appendRecord(workflow.ledger, { type: "dispatch", ...record });
  } catch (error) {
    return `Task gate: the ledger write failed (${error.message}), so this dispatch is not recorded.`;
  }
  return note;
}
