#!/usr/bin/env node
// The trigger that holds an implementer to test first and a reviewer to a verdict a machine can read. The
// hand-back gate refuses a report without its lines, and the stop records the verdict in the ledger.

import os from "node:os";
import { fileURLToPath } from "node:url";
import { branchesAt, commitOf } from "./git-read.mjs";
import { appendRecord } from "./ledger.mjs";
import { dropReport, keepReport, reportOf } from "./report-stash.mjs";
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

/** @returns each line the report still needs, as a phrase; empty when it carries every line its role owes. */
export function reportProblems(role, text, verdict, fullSha) {
  if (role === "implementer") {
    const problems = [];
    if (!RED_LINE.test(text)) problems.push("a line that starts `RED:` with the test command and the line that shows it failing before the code");
    if (!GREEN_LINE.test(text)) problems.push("a line that starts `GREEN:` with the same command and the line that shows it passing after");
    return problems;
  }
  if (!verdict) return ["a first line `VERDICT: APPROVED <sha>` or `VERDICT: CHANGES_REQUIRED <sha>`, where <sha> is the commit you reviewed"];
  if (!fullSha) return [`a sha this repository holds, and ${verdict.sha} names no commit (git rev-parse)`];
  if (role === "task" && verdict.verdict === "APPROVED" && !RED_CHECKED_LINE.test(text)) {
    return ["a line that starts `RED-CHECKED:` and says how you saw the test fail before the code"];
  }
  return [];
}

const refusal = (role, problems) =>
  `Workflow report: the ${role === "implementer" ? "implementer" : `${role} review`} report needs ${problems.join("; and ")}. ` +
  "Add it and send the report again.";

function branchOf(workflow, sha) {
  const branches = branchesAt(workflow.root, sha);
  return branches.find((branch) => !workflow.protectedBranches.includes(branch)) ?? branches[0] ?? null;
}

function recordStop({ workflow, call, session, agentId, role, verdict, fullSha, text, tmp }) {
  try {
    appendRecord(workflow.ledger, { type: "stop", session, agentType: call.agent_type, agentId, role });
    if (verdict) {
      appendRecord(workflow.ledger, {
        type: "verdict",
        session,
        agentId,
        kind: role,
        verdict: verdict.verdict,
        sha: fullSha,
        branch: branchOf(workflow, fullSha),
        redChecked: RED_CHECKED_LINE.test(text),
      });
    }
    dropReport(session, agentId, tmp);
  } catch (error) {
    return { systemMessage: `Workflow report: the ledger write failed (${error.message}), so this ${role} stop is not recorded.` };
  }
  return null;
}

/** The verdict on one hook event. @returns the hook output, or null to let it pass with no message. */
export function decide(call, tmp = os.tmpdir()) {
  const event = call.hook_event_name;
  const onHandback = call.tool_name === HANDBACK && (event === "PreToolUse" || event === "PostToolUse");
  if (!onHandback && event !== "SubagentStop") return null;
  const agentId = idOf(call.agent_id);
  if (!agentId) return null;
  let workflow;
  try {
    workflow = workflowOf(call, tmp);
  } catch (error) {
    // A config typo must not trap an agent; the hand-back names it, and the other events stay quiet.
    return event === "PreToolUse" ? preContext(`Workflow checks are off: ${error.message}`) : null;
  }
  if (!workflow) return null;
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
  const text = event === "PreToolUse" ? String(call.tool_input?.message ?? "") : reportOf(call, tmp);
  const verdict = role === "implementer" ? null : verdictOf(text);
  const fullSha = verdict ? commitOf(workflow.root, verdict.sha) : null;
  const problems = reportProblems(role, text, verdict, fullSha);
  if (problems.length > 0) return event === "PreToolUse" ? deny(refusal(role, problems)) : block(refusal(role, problems));
  if (event === "PreToolUse") return null;
  return recordStop({ workflow, call, session, agentId, role, verdict, fullSha, text, tmp });
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
