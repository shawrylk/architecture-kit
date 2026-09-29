#!/usr/bin/env node
// The trigger for `swarm.dispatch`. PreToolUse on Agent judges a dispatch and claims the implementer
// slot. SubagentStart claims it again for a resumed implementer, and SubagentStop frees it.

import { existsSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { dispatchRefusal, dispatchSettingsAt, isImplementer, slotRefusal, typeOf } from "./dispatch.mjs";
import { claimSlot, reclaimSlot, releaseSlot, slotDirOf } from "./dispatch-slot.mjs";

const output = (fields) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", ...fields } });
const deny = (reason) => output({ permissionDecision: "deny", permissionDecisionReason: reason });
const context = (text) => output({ additionalContext: text });

const idOf = (value) => (typeof value === "string" && value !== "" ? value : undefined);

/** Claims or frees the slot as a subagent starts or stops. It reads no config, since the agent's cwd is its own. */
function onSubagent(call, dir, now) {
  // Only a claim makes the folder, so a session with the guard off gets no file here.
  if (!existsSync(dir)) return;
  try {
    if (call.hook_event_name === "SubagentStart") reclaimSlot(dir, call.agent_type, now, idOf(call.agent_id));
    else releaseSlot(dir, call.agent_type, idOf(call.agent_id));
  } catch {
    // A busy or read-only temp folder is the hook's own problem, and the slot still expires.
  }
}

/** The verdict on one hook event. @returns the hook output, or null to let the call run with no message. */
export function decide(call, tmp = os.tmpdir(), now = Date.now()) {
  const dir = slotDirOf(call.session_id ?? "session", tmp);
  if (call.hook_event_name === "SubagentStart" || call.hook_event_name === "SubagentStop") {
    onSubagent(call, dir, now);
    return null;
  }
  if (call.hook_event_name !== "PreToolUse" || call.tool_name !== "Agent") return null;
  // A subagent's dispatch follows its own definition, often another plugin's; the orchestrator is the main session.
  if (typeof call.agent_id === "string" && call.agent_id !== "") return null;

  let settings;
  try {
    settings = dispatchSettingsAt(call.cwd ?? process.cwd());
  } catch (error) {
    // A config typo must not stop every dispatch; the session sees the error and reports it.
    return context(`Dispatch guard is off: ${error.message}`);
  }
  if (!settings) return null;

  const input = call.tool_input ?? {};
  const refusal = dispatchRefusal(input, settings);
  if (refusal) return deny(refusal);
  const type = typeOf(input);
  if (!isImplementer(type, settings)) return null;
  let holder;
  try {
    holder = claimSlot(dir, settings, now, idOf(call.tool_use_id));
  } catch {
    // A busy or read-only temp folder is the hook's own problem, never a reason to refuse a dispatch.
    return null;
  }
  return holder ? deny(slotRefusal({ type, ...holder })) : null;
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
