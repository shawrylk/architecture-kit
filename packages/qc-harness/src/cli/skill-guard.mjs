#!/usr/bin/env node
// PreToolUse on Skill, a check of `swarm.dispatch`: the model never runs a code-review skill. The user
// types `/code-review`, which never reaches this tool, and a branch review is a dispatch of the reviewer.

import { fileURLToPath } from "node:url";
import { workflowAt } from "./workflow-settings.mjs";

const output = (fields) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", ...fields } });

/** True when `name`, or the part after its last `:`, is in `list`. Case and a leading slash do not count. */
export function isListedSkill(name, list) {
  if (typeof name !== "string") return false;
  const bare = name.trim().replace(/^\//, "").toLowerCase();
  if (bare === "") return false;
  const lower = list.map((entry) => entry.toLowerCase());
  return lower.includes(bare) || lower.includes(bare.slice(bare.lastIndexOf(":") + 1));
}

const refusal = (name) =>
  `Skill guard: the model may not run the ${name} skill while swarm.dispatch is on, because it reviews in the main session's context. ` +
  "Dispatch architecture:sdd-branch-reviewer for a branch review, or ask the user to type `/code-review`. " +
  "To allow a skill, remove it from swarm.review.codeReviewSkills in qc.config.json.";

/** @returns the hook output, or null to let the call run. */
export function decide(call) {
  if (call.hook_event_name !== "PreToolUse" || call.tool_name !== "Skill") return null;
  const name = call.tool_input?.skill;
  if (typeof name !== "string") return null;
  let workflow;
  try {
    workflow = workflowAt(call.cwd ?? process.cwd());
  } catch (error) {
    // A config typo must not stop every skill; the session sees the error and reports it.
    return output({ additionalContext: `Skill guard is off: ${error.message}` });
  }
  if (!workflow || !isListedSkill(name, workflow.review.codeReviewSkills)) return null;
  return output({ permissionDecision: "deny", permissionDecisionReason: refusal(name.trim()) });
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
    // Not hook input, so there is nothing to judge.
  }
  const result = call ? decide(call) : null;
  if (result) process.stdout.write(JSON.stringify(result));
}
