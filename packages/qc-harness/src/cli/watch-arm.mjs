#!/usr/bin/env node
// The SessionStart trigger tells the orchestrator to arm event watches and an hourly check.

import { fileURLToPath } from "node:url";
import { dispatchSettingsAt } from "./dispatch.mjs";

export const ARM_NOTE =
  "Event waits: for each pending item (an open PR, a Codex job, a workflow run), start one background " +
  "`qc watch --pr <n> --codex <wrapper.log> --run <workflow>@<branch>`, and re-arm it after each EVENT line. " +
  "A hook cannot create a cron, so create one hourly dead-man check yourself: it lists the pending items " +
  "and re-arms every watch that ended with no EVENT line.";

export function decide(call, env = process.env) {
  if (env.QC_ROLE === "implementer") return null;
  try {
    if (!dispatchSettingsAt(call.cwd ?? process.cwd())) return null;
  } catch {
    return null;
  }
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ARM_NOTE } };
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
    // Invalid hook input carries no checkout to inspect.
  }
  const result = call ? decide(call) : null;
  if (result) process.stdout.write(JSON.stringify(result));
}
