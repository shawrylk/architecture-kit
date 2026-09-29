#!/usr/bin/env node
// The trigger that holds an implementer to test first and a reviewer to a verdict a machine can read. The
// hand-back gate refuses a report without its lines, and the stop records the verdict in the ledger.

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkoutRootOf } from "./checkout-root.mjs";
import { branchAt, branchesAt, gitOut, pathKey } from "./git-read.mjs";
import { appendRecord, readLedger } from "./ledger.mjs";
import { dropReport, keepReport, reportOf } from "./report-stash.mjs";
import { commitLookup, nativePath, transcriptWorktree, workflowOfRepo } from "./workflow-place.mjs";
import { workflowOf } from "./workflow-settings.mjs";

const HANDBACK = "SubagentHandback";
const VERDICT_LINE = /^[ \t]*VERDICT:[ \t]+(APPROVED|CHANGES_REQUIRED)[ \t]+([0-9a-fA-F]{7,40})\b/;
const RED_LINE = /^[ \t]*RED:[ \t]*\S/m;
const GREEN_LINE = /^[ \t]*GREEN:[ \t]*\S/m;
const RED_CHECKED_LINE = /^[ \t]*RED-CHECKED:[ \t]*\S/m;

const idOf = (value) => (typeof value === "string" && value !== "" ? value : null);
const preContext = (text) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } });
const deny = (reason) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
const block = (reason) => ({ decision: "block", reason });

/** The role an agent type plays under the review settings, or null for a type the checks leave alone. */
export function roleOf(agentType, review) {
  if (review.implementerTypes.includes(agentType)) return "implementer";
  if (review.reviewerTypes.task.includes(agentType)) return "task";
  if (review.reviewerTypes.branch.includes(agentType)) return "branch";
  return null;
}

/** The verdict on the first non-blank line of a report, or null when that line carries none. */
export function verdictOf(text) {
  const first = String(text).split(/\r?\n/).find((line) => line.trim() !== "");
  const match = first === undefined ? null : VERDICT_LINE.exec(first);
  return match ? { verdict: match[1], sha: match[2].toLowerCase() } : null;
}

/**
 * @param lookup the read of the verdict's sha, `{ sha }`, `{ unknown }`, `{ error }`, or null
 * @param named true when the dispatch names the worktree whose repository the sha must belong to
 * @returns each line the report still needs, as a phrase; empty when it carries every line its role owes
 */
export function reportProblems(role, text, verdict, lookup, named) {
  if (role === "implementer") {
    const problems = [];
    if (!RED_LINE.test(text)) problems.push("a line that starts `RED:` with the test command and the line that shows it failing before the code");
    if (!GREEN_LINE.test(text)) problems.push("a line that starts `GREEN:` with the same command and the line that shows it passing after");
    return problems;
  }
  if (!verdict) return ["a first line `VERDICT: APPROVED <sha>` or `VERDICT: CHANGES_REQUIRED <sha>`, where <sha> is the commit you reviewed"];
  if (lookup?.unknown && named) return [`a sha this repository holds, and ${verdict.sha} names no commit (git rev-parse)`];
  if (role === "task" && verdict.verdict === "APPROVED" && !RED_CHECKED_LINE.test(text)) {
    return ["a line that starts `RED-CHECKED:` and says how you saw the test fail before the code"];
  }
  return [];
}

const refusal = (role, problems) =>
  `Workflow report: the ${role === "implementer" ? "implementer" : `${role} review`} report needs ${problems.join("; and ")}. ` +
  "Add it and send the report again.";

/** A block already held this stop once, so it ends now, records nothing, and says what is still missing. */
const held = (role, problems) => ({
  systemMessage: `${refusal(role, problems)} A block already held this stop once, so it ends now and the ledger records nothing.`,
});

const MAX_BRANCH_PROBES = 10;

/** The dispatches of this session that named a worktree, newest first. */
const dispatchesOf = (records, session) =>
  records.filter((record) => record.type === "dispatch" && record.session === session && record.worktree).reverse();

/**
 * The branch a verdict's commit belongs to. The worktree of the reviewer's own dispatch decides first. When
 * the dispatch names none, a worktree that an earlier dispatch left on one of the branches wins. Each distinct
 * worktree costs one git process, and no more than ten are tried.
 */
export function branchOf(workflow, sha, { worktree = null, dispatches = [] } = {}, at = { branchesAt, branchAt }) {
  const branches = at.branchesAt(worktree ?? workflow.root, sha);
  const seen = new Set();
  for (const dir of worktree ? [worktree] : dispatches.map((dispatch) => dispatch.worktree)) {
    const key = pathKey(dir);
    if (seen.has(key)) continue;
    if (seen.size >= MAX_BRANCH_PROBES) break;
    seen.add(key);
    const checkedOut = at.branchAt(dir);
    if (checkedOut && branches.includes(checkedOut)) return checkedOut;
  }
  return branches.find((branch) => !workflow.protectedBranches.includes(branch)) ?? branches[0] ?? null;
}

const dispatchHeadOf = (records, worktree) =>
  records.findLast(
    (record) => record.type === "dispatch" && record.task === true && typeof record.worktree === "string" && pathKey(record.worktree) === pathKey(worktree),
  )?.head ?? null;

/**
 * What an implementer stop records about its worktree. The head goes in only when it moved since the
 * dispatch, since only a commit needs a review.
 */
function implementerPlace(records, worktree) {
  const branch = branchAt(worktree);
  const head = gitOut(worktree, "rev-parse", "HEAD");
  const place = branch ? { worktree, branch } : { worktree };
  if (!head || !branch) return place;
  const dispatched = dispatchHeadOf(records, worktree);
  return typeof dispatched === "string" && dispatched.toLowerCase() === head.toLowerCase() ? place : { ...place, head };
}

/**
 * Where the work of the stopping agent lives. The worktree its own prompt names decides, and its repository
 * supplies the workflow. Without one, the checkout of the hook's cwd or the session decides.
 * @returns `{ workflow, named }`, `{ off }` for a repository with no workflow, or null; throws on a wrong config
 */
function locate(call, tmp) {
  const spelled = transcriptWorktree(call.agent_transcript_path);
  if (spelled !== null) {
    const abs = path.resolve(call.cwd ?? process.cwd(), nativePath(spelled));
    const root = existsSync(abs) ? checkoutRootOf(abs) : null;
    if (root) {
      const workflow = workflowOfRepo(root);
      return workflow ? { workflow, named: root } : { off: root };
    }
  }
  const workflow = workflowOf(call, tmp);
  return workflow ? { workflow, named: null } : null;
}

/** The note for an agent whose work is in a repository with no workflow, or null when the cwd's workflow does not track its type. */
function offNote(call, root, event, tmp) {
  let own = null;
  try {
    own = workflowOf(call, tmp);
  } catch {
    return null;
  }
  if (!own || !roleOf(call.agent_type, own.review)) return null;
  const note = `Workflow checks are off for ${root}: the repository has no swarm workflow, so this report is not judged.`;
  if (event === "PreToolUse") return preContext(note);
  return event === "SubagentStop" ? { systemMessage: note } : null;
}

function recordStop({ workflow, call, session, agentId, role, worktree, verdict, lookup, text, tmp, records, notes }) {
  try {
    const place = worktree ? (role === "implementer" ? implementerPlace(records, worktree) : { worktree }) : {};
    appendRecord(workflow.ledger, { type: "stop", session, agentType: call.agent_type, agentId, role, ...place });
    // A failed read keeps the sha as the reviewer wrote it, which the gates match by prefix.
    const sha = lookup?.sha ?? (lookup?.error ? verdict.sha : null);
    if (verdict && sha) {
      appendRecord(workflow.ledger, {
        type: "verdict",
        session,
        agentId,
        kind: role,
        verdict: verdict.verdict,
        sha,
        branch: lookup.sha ? branchOf(workflow, sha, { worktree, dispatches: dispatchesOf(records, session) }) : null,
        redChecked: RED_CHECKED_LINE.test(text),
      });
    }
    dropReport(session, agentId, tmp);
  } catch (error) {
    notes.push(`Workflow report: the ledger write failed (${error.message}), so this ${role} stop is not recorded.`);
  }
  return notes.length > 0 ? { systemMessage: notes.join(" ") } : null;
}

/**
 * The verdict on one hook event. @returns the hook output, or null to let it pass with no message.
 * `deps.commit` replaces the git read of a sha, for a test.
 */
export function decide(call, tmp = os.tmpdir(), deps = {}) {
  const commit = deps.commit ?? commitLookup;
  const event = call.hook_event_name;
  const onHandback = call.tool_name === HANDBACK && (event === "PreToolUse" || event === "PostToolUse");
  if (!onHandback && event !== "SubagentStop") return null;
  const agentId = idOf(call.agent_id);
  if (!agentId) return null;
  let where;
  try {
    where = locate(call, tmp);
  } catch (error) {
    // A config typo must not trap an agent; the hand-back names it, and the other events stay quiet.
    return event === "PreToolUse" ? preContext(`Workflow checks are off: ${error.message}`) : null;
  }
  if (!where) return null;
  if (where.off) return offNote(call, where.off, event, tmp);
  const { workflow, named } = where;
  const role = roleOf(call.agent_type, workflow.review);
  if (!role) return null;
  const session = call.session_id ?? "session";
  if (event === "PostToolUse") {
    try {
      keepReport(session, agentId, String(call.tool_input?.message ?? ""), tmp);
    } catch {
      // Without the kept report the stop judges the closing text, and asks for the lines again.
    }
    return null;
  }
  let records = [];
  try {
    records = readLedger(workflow.ledger);
  } catch {
    // An unreadable ledger leaves the agent with no earlier stop, and the write below reports its own failure.
  }
  // A resumed agent stops again in the worktree of its first stop, whatever was dispatched since.
  const prior = records.findLast(
    (record) => record.type === "stop" && record.agentId === agentId && record.session === session && typeof record.worktree === "string",
  );
  const worktree = prior?.worktree ?? named;
  const text = event === "PreToolUse" ? String(call.tool_input?.message ?? "") : reportOf(call, tmp);
  const verdict = role === "implementer" ? null : verdictOf(text);
  const lookup = verdict ? commit(worktree ?? workflow.root, verdict.sha) : null;
  const notes = [];
  if (lookup?.error) {
    notes.push(`Workflow report: git could not read ${verdict.sha} (${lookup.error}), so the verdict is not checked and is recorded as written.`);
  } else if (lookup?.unknown && !worktree) {
    notes.push(
      `Workflow report: ${verdict.sha} names no commit in ${workflow.root}, and the dispatch names no other worktree, so the verdict is not checked and not recorded.`,
    );
  }
  if (event === "SubagentStop" && role === "implementer" && !worktree) {
    notes.push("Workflow report: the prompt of this implementer has no readable `Worktree:` line, so the stop records no head.");
  }
  const problems = reportProblems(role, text, verdict, lookup, worktree !== null);
  if (problems.length > 0) {
    if (event === "PreToolUse") return deny(refusal(role, problems));
    return call.stop_hook_active === true ? held(role, problems) : block(refusal(role, problems));
  }
  if (event === "PreToolUse") return notes.length > 0 ? preContext(notes.join(" ")) : null;
  return recordStop({ workflow, call, session, agentId, role, worktree, verdict, lookup, text, tmp, records, notes });
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const isEntryPoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntryPoint) {
  let call = null;
  try {
    call = JSON.parse(await readStdin());
  } catch {
    // Not hook input, so there is no report to judge.
  }
  const output = call ? decide(call) : null;
  if (output) process.stdout.write(JSON.stringify(output));
}
