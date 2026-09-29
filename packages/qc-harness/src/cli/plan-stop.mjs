#!/usr/bin/env node
// The trigger that runs the plan check when a planner reports. The hand-back gate refuses a report whose
// plan fails `qc plan-check`, and the stop records the plan in the ledger.

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendRecord } from "./ledger.mjs";
import { checkPlan } from "./plan-check.mjs";
import { dropReport, keepReport, reportOf } from "./report-stash.mjs";
import { nativePath } from "./workflow-place.mjs";
import { workflowOf } from "./workflow-settings.mjs";

const HANDBACK = "SubagentHandback";
const PLAN_LINE = /^[ \t]*PLAN:[ \t]*(\S.*?)[ \t]*$/m;
const QUOTES = /^["'`]|["'`]$/g;

const preContext = (text) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } });
const deny = (reason) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
const block = (reason) => ({ decision: "block", reason });

/** The path on a report's `PLAN:` line, or null. */
export const planPathOf = (text) => PLAN_LINE.exec(String(text))?.[1]?.replace(QUOTES, "") ?? null;

/** @returns what the planner must fix before its report goes through; empty when the plan passes. */
export function planProblems(text, cwd, maxTaskCalls) {
  const named = planPathOf(text);
  if (!named) return ["a line that starts `PLAN:` with the plan's absolute path"];
  const file = path.resolve(cwd, nativePath(named));
  let markdown;
  try {
    markdown = readFileSync(file, "utf8");
  } catch {
    return [`a plan at ${file}, which cannot be read`];
  }
  return checkPlan(markdown, { maxTaskCalls }).map((problem) => (problem.task === null ? problem.detail : `Task ${problem.task} ${problem.detail}`));
}

const refusal = (problems) => `Plan check: fix these, then send the report again. ${problems.map((problem, i) => `${i + 1}) ${problem}.`).join(" ")}`;

/** A block already held this stop once, so it ends now, records nothing, and says what is still missing. */
const held = (problems) => ({ systemMessage: `${refusal(problems)} A block already held this stop once, so it ends now and the ledger records nothing.` });

/** The verdict on one hook event. @returns the hook output, or null to let it pass with no message. */
export function decide(call, tmp = os.tmpdir()) {
  const event = call.hook_event_name;
  const onHandback = call.tool_name === HANDBACK && (event === "PreToolUse" || event === "PostToolUse");
  if (!onHandback && event !== "SubagentStop") return null;
  const agentId = typeof call.agent_id === "string" && call.agent_id !== "" ? call.agent_id : null;
  if (!agentId) return null;
  let workflow;
  try {
    workflow = workflowOf(call, tmp);
  } catch (error) {
    return event === "PreToolUse" ? preContext(`Plan check is off: ${error.message}`) : null;
  }
  if (!workflow || !workflow.review.plannerTypes.includes(call.agent_type)) return null;
  const session = call.session_id ?? "session";
  if (event === "PostToolUse") {
    try {
      keepReport(session, agentId, String(call.tool_input?.message ?? ""), tmp);
    } catch {
      // Without the kept report the stop judges the closing text, and asks for the PLAN: line again.
    }
    return null;
  }
  const text = event === "PreToolUse" ? String(call.tool_input?.message ?? "") : reportOf(call, tmp);
  const cwd = call.cwd ?? process.cwd();
  const problems = planProblems(text, cwd, workflow.review.maxTaskCalls);
  if (problems.length > 0) {
    if (event === "PreToolUse") return deny(refusal(problems));
    return call.stop_hook_active === true ? held(problems) : block(refusal(problems));
  }
  if (event === "PreToolUse") return null;
  try {
    appendRecord(workflow.ledger, { type: "stop", session, agentType: call.agent_type, agentId, role: "planner", plan: path.resolve(cwd, nativePath(planPathOf(text))) });
    dropReport(session, agentId, tmp);
  } catch (error) {
    return { systemMessage: `Plan check: the ledger write failed (${error.message}), so this planner stop is not recorded.` };
  }
  return null;
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
    // Not hook input, so there is no plan to check.
  }
  const output = call ? decide(call) : null;
  if (output) process.stdout.write(JSON.stringify(output));
}
