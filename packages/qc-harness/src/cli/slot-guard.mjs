#!/usr/bin/env node
// PreToolUse on a shell command or an edit: a subagent may not touch a slot folder. The hooks and
// `qc gate-slot` own those files, and a hand edit leaves a slot claimed or frees one still in use.

import { fileURLToPath } from "node:url";

const SLOT_FOLDER = /architecture-kit[\\/]+(?:dispatch|gate-slots)(?:[\\/"'\s]|$)/i;
const REASON =
  "Slot guard: a subagent may not touch a slot folder. The hooks and `qc gate-slot` own those files. " +
  "Wrap a heavy command in `npx qc gate-slot --`, and ask the controller to free a slot.";

const norm = (text) => text.replace(/\\+/g, "/").toLowerCase();

/** The text of a call that can name a path: its command, or its file path. */
const targetOf = (input) => [input?.command, input?.file_path, input?.notebook_path].filter((value) => typeof value === "string").join("\n");

/** @returns the hook output that denies the call, or null to let it run */
export function decide(call, env = process.env) {
  if (call?.hook_event_name !== "PreToolUse") return null;
  if (typeof call.agent_id !== "string" || call.agent_id === "") return null;
  const text = targetOf(call.tool_input);
  const custom = typeof env.QC_GATE_SLOT_DIR === "string" && env.QC_GATE_SLOT_DIR !== "" && norm(text).includes(norm(env.QC_GATE_SLOT_DIR));
  if (!SLOT_FOLDER.test(text) && !custom) return null;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: REASON } };
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
