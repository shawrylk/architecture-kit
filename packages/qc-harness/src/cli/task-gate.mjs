// The branch that holds the main session to the task order: a review before the next implementer on a
// branch, and a fix round back to the implementer that wrote it. The dispatch guard calls it.

import os from "node:os";
import path from "node:path";
import { checkoutRootOf } from "./checkout-root.mjs";
import { typeOf } from "./dispatch.mjs";
import { branchAt, gitOut, linkedWorktrees, pathKey } from "./git-read.mjs";
import { appendRecord, latestVerdictFor, latestVerdictOn, readLedger, shaMatches } from "./ledger.mjs";
import { resolveNamedWorktree, workflowOfRepo, worktreeNamed } from "./workflow-place.mjs";
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
  `\`qc ledger ${branch}\` lists what is recorded.`;

const HISTORY_LIMIT = 5000;

/**
 * The head of the newest implementer stop in this branch's history that no later verdict on the branch covers,
 * or null. Older stops are ancestors of it, so its verdict covers them. Two git calls at most; a git error passes.
 */
function unreviewedImplementerHead({ records, branch, head, cwd, git }) {
  if (cwd === undefined) return null;
  const history = git(cwd, "rev-list", `--max-count=${HISTORY_LIMIT}`, head);
  if (history === null) return null;
  const inHistory = new Set(history.split(/\r?\n/).map((sha) => sha.toLowerCase()));
  const stopAt = records.findLastIndex(
    (record) =>
      record.type === "stop" && record.role === "implementer" && record.branch === branch && typeof record.head === "string" && inHistory.has(record.head.toLowerCase()),
  );
  if (stopAt < 0) return null;
  const stopHead = records[stopAt].head;
  // A commit is reviewed once, wherever and whenever the verdict on it was written.
  if (records.some((record) => record.type === "verdict" && shaMatches(record.sha, stopHead))) return null;
  const later = records.slice(stopAt + 1).filter((record) => record.type === "verdict" && record.branch === branch && typeof record.sha === "string");
  if (later.length === 0 || shaMatches(stopHead, head)) return stopHead;
  const below = git(cwd, "rev-list", "--ancestry-path", `${stopHead}..${head}`);
  if (below === null) return null;
  const descendants = below.split(/\r?\n/).filter(Boolean);
  return later.some((verdict) => descendants.some((sha) => shaMatches(verdict.sha, sha))) ? null : stopHead;
}

/**
 * @returns the reason an implementer may not start on `branch` now, or null. Only implementer commits need a
 * review, so a controller commit after a reviewed head passes. `cwd` is any checkout; `git` reads it.
 */
export function gateRefusal({ records, branch, head, reason, type, cwd, git = gitOut }) {
  const last = latestVerdictOn(records, branch);
  if (last?.verdict === "CHANGES_REQUIRED" && reason === null) return fixRoundRefusal(branch, last.sha, type);
  const unreviewed = unreviewedImplementerHead({ records, branch, head, cwd, git });
  if (unreviewed) return unreviewedRefusal(branch, unreviewed, head);
  const current = latestVerdictFor(records, head, ["task", "branch"]);
  if (current?.verdict === "CHANGES_REQUIRED" && reason === null) return fixRoundRefusal(branch, current.sha, type);
  return null;
}

const pass = (workflow, record, note = null) => ({ refusal: null, workflow, record, note });
const refuse = (refusal) => ({ refusal, workflow: null, record: null, note: null });

const taskTypeIn = (type, review) =>
  review.implementerTypes.includes(type) || review.reviewerTypes.task.includes(type) || review.reviewerTypes.branch.includes(type);

/**
 * Judges one main-session Agent call. The repository of the worktree the prompt names decides, and the
 * repository of the cwd decides only when the prompt names none.
 * @returns the refusal, or the record to write once the dispatch runs.
 */
export function judgeTask(call, tmp = os.tmpdir()) {
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
  if (named === null || !taskTypeIn(type, workflow.review)) return pass(workflow, base);
  if (!workflow.review.implementerTypes.includes(type)) {
    // A reviewer is never gated. Its worktree tells the stop which branch the verdict belongs to.
    if (!root) return pass(workflow, base);
    return pass(workflow, { ...base, worktree: root, branch: branchAt(root), head: gitOut(root, "rev-parse", "HEAD") });
  }
  const key = pathKey(abs);
  const worktree = linkedWorktrees(workflow.root).find((entry) => pathKey(entry.path) === key);
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
  const refusal = gateRefusal({ records, branch: worktree.branch, head: worktree.head, reason, type, cwd: workflow.root });
  if (refusal) return refuse(refusal);
  return pass(workflow, { ...base, task: true, worktree: worktree.path, branch: worktree.branch, head: worktree.head, resumeReason: reason });
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
