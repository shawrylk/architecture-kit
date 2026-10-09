#!/usr/bin/env node
// The PreToolUse trigger that keeps the main session a controller while `swarm.dispatch` is on: it edits only `swarm.review.controllerPaths`,
// or a small fix inside `swarm.direct`. It guards the edit tools; a shell write is only reported, by `bash-edit-guard.mjs`.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathMatcher } from "../glob.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { editLane, sizeLine } from "./direct-lane.mjs";
import { pathKey } from "./git-read.mjs";
import { commonDirOf } from "./ledger.mjs";
import { workflowAt } from "./workflow-settings.mjs";

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const deny = (reason) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
const context = (text) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } });

function sameRepository(a, b) {
  const [left, right] = [commonDirOf(a), commonDirOf(b)];
  return left !== null && right !== null && pathKey(left) === pathKey(right);
}

/** True when `rel` matches a controller glob, with no case on Windows. */
export const isControllerPath = (rel, controllerPaths, platform = process.platform) => pathMatcher(controllerPaths, platform)(rel);

/** The verdict on one edit. @returns the hook output, or null to let the edit run with no message. */
export function decide(call, platform = process.platform) {
  if (call.hook_event_name !== "PreToolUse" || !EDIT_TOOLS.has(call.tool_name)) return null;
  if (typeof call.agent_id === "string" && call.agent_id !== "") return null;
  const input = call.tool_input ?? {};
  const target = input.file_path ?? input.notebook_path;
  if (typeof target !== "string" || target === "") return null;
  const cwd = call.cwd ?? process.cwd();
  let workflow;
  try {
    workflow = workflowAt(cwd);
  } catch (error) {
    return context(`Controller guard is off: ${error.message}`);
  }
  if (!workflow) return null;
  const file = path.resolve(cwd, target);
  const fileRoot = checkoutRootOf(path.dirname(file));
  if (!fileRoot || !sameRepository(fileRoot, workflow.root)) return null;
  const rel = path.relative(fileRoot, file).replaceAll("\\", "/");
  const { controllerPaths } = workflow.review;
  if (isControllerPath(rel, controllerPaths, platform)) return null;
  const { direct } = workflow;
  const lane = direct
    ? editLane({ root: fileRoot, base: workflow.base, direct, protectedBranches: workflow.protectedBranches, rel, toolName: call.tool_name, input })
    : workflow.directProblem && { problem: workflow.directProblem };
  if (lane && lane.problem === null) {
    return context(`Direct lane: with this edit the branch changes ${sizeLine(lane.size, direct)}, so the fix needs no implementer. Merge it with \`--match-head-commit <sha>\`.`);
  }
  const laneNote = lane ? ` The direct lane of swarm.direct does not apply: ${lane.problem}.` : "";
  return deny(
    `Controller guard: while swarm.dispatch is on, the main session edits only swarm.review.controllerPaths (${controllerPaths.join(", ")}), ` +
      `and ${rel} is outside them. Write a brief and dispatch an implementer for this change. ` +
      "For a path the controller owns, add its glob to swarm.review.controllerPaths in qc.config.json." +
      laneNote,
  );
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
    // Not hook input, so there is no edit to judge.
  }
  const output = call ? decide(call) : null;
  if (output) process.stdout.write(JSON.stringify(output));
}
