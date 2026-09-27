#!/usr/bin/env node
// The SessionStart trigger for `swarm.dispatch`: one short note at each start, resume, clear and
// compaction, because a rule held only in the conversation is lost to a compaction.

import { fileURLToPath } from "node:url";
import { dispatchSettingsAt } from "./dispatch.mjs";

export const REMINDER =
  "Subagent workflow (swarm.dispatch in qc.config.json): run a plan with superpowers:subagent-driven-development. " +
  "Dispatch architecture:sdd-planner to write a plan, architecture:sdd-implementer for one task, and " +
  "architecture:sdd-reviewer to review it. Run one implementer at a time: a hook refuses a second while one runs. " +
  "Name a model on any other dispatch, and pass each brief as a file path.";

const context = (text) => ({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } });

/** @returns the hook output, or null when the checkout does not turn the section on. */
export function decide(call) {
  let settings;
  try {
    settings = dispatchSettingsAt(call.cwd ?? process.cwd());
  } catch (error) {
    return context(`Dispatch guard is off: ${error.message}`);
  }
  return settings ? context(REMINDER) : null;
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
    // Not hook input, so there is no checkout to read.
  }
  const result = call ? decide(call) : null;
  if (result) process.stdout.write(JSON.stringify(result));
}
