#!/usr/bin/env node
// The PreToolUse trigger for the tool-call budget of swarm.md. It runs on every call of every agent,
// so it spawns no process and touches one small file. The main session has no agent id and is exempt.

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE, load } from "../config.mjs";
import { budgetOf, budgetVerdict } from "./budget.mjs";
import { bumpCount, counterFileOf } from "./budget-counter.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";

const context = (text) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } });

/** The verdict on one tool call. @returns the hook output, or null to let the call run with no message. */
export function decide(call, tmp = os.tmpdir()) {
  const agentId = call.agent_id;
  if (typeof agentId !== "string" || agentId === "") return null;
  const root = checkoutRootOf(call.cwd ?? process.cwd());
  if (!root || !existsSync(path.join(root, CONFIG_FILE))) return null;

  let budget;
  try {
    budget = budgetOf(load(root).swarm);
  } catch (error) {
    // A config typo must not stop every agent; the agent sees the error and reports it.
    return context(`Tool-call budget is off: ${error.message}`);
  }
  let count;
  try {
    count = bumpCount(counterFileOf(call.session_id ?? "session", agentId, tmp));
  } catch {
    // A busy or read-only temp folder is the hook's own problem, never a reason to stop the agent.
    return null;
  }
  return budgetVerdict({ count, budget, call });
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
    // Not hook input, so there is nothing to count.
  }
  const output = call ? decide(call) : null;
  if (output) process.stdout.write(JSON.stringify(output));
}
