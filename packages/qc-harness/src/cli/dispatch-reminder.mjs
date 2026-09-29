#!/usr/bin/env node
// The SessionStart trigger for `swarm.dispatch`: one short note at each start, resume, clear, compaction
// and fork, because a rule held only in the conversation is lost to a compaction.

import { fileURLToPath } from "node:url";
import { dispatchSettingsAt, exploreSettingsAt } from "./dispatch.mjs";

export const REMINDER =
  "Subagent workflow (swarm.dispatch in qc.config.json): run a plan with superpowers:subagent-driven-development. " +
  "Dispatch architecture:sdd-planner to write a plan, architecture:sdd-implementer for one task, and " +
  "architecture:sdd-reviewer to review it; before merge, dispatch architecture:sdd-branch-reviewer to review the " +
  "whole branch. The planner and the branch reviewer run on opus, the implementer and the task reviewer on sonnet. " +
  "Run one implementer at a time: a hook refuses a second while one runs. Name a model on any other dispatch, and " +
  "pass each brief as a file path.";

const context = (eventName, text) => ({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } });

/** One added line for a limit above 1, which overrides the one-at-a-time rule of the note. */
const slotsLine = ({ implementerSlots }) =>
  implementerSlots > 1
    ? ` This repository allows up to ${implementerSlots} implementers at once, each in its own worktree, so the one-at-a-time rule above does not apply. A hook refuses one over the limit.`
    : "";

/** One added line naming `swarm.explore`'s tools, or "" when the section is off or names none. */
function exploreLine(cwd) {
  let settings;
  try {
    settings = exploreSettingsAt(cwd);
  } catch {
    // The explore guard and hint each report their own config error; the dispatch note stays unaffected.
    return "";
  }
  if (!settings || settings.tools.length === 0) return "";
  return ` The repository's own explore tools: ${settings.tools.map((tool) => tool.name).join(", ")}.`;
}

/** @returns the hook output for a subagent's own start, or null when `swarm.explore` names no tools. */
function decideSubagentStart(cwd) {
  const line = exploreLine(cwd).trim();
  return line === "" ? null : context("SubagentStart", line);
}

/** @returns the hook output, or null when the checkout turns on neither `swarm.dispatch` nor `swarm.explore`. */
function decideSessionStart(call) {
  const cwd = call.cwd ?? process.cwd();
  let dispatch;
  try {
    dispatch = dispatchSettingsAt(cwd);
  } catch (error) {
    return context("SessionStart", `Dispatch guard is off: ${error.message}`);
  }
  const explore = exploreLine(cwd);
  if (!dispatch) return explore === "" ? null : context("SessionStart", explore.trim());
  return context("SessionStart", `${REMINDER}${slotsLine(dispatch)}${explore}`);
}

/** @returns the hook output, or null when there is nothing to add for this event. */
export function decide(call) {
  if (call.hook_event_name === "SubagentStart") return decideSubagentStart(call.cwd ?? process.cwd());
  return decideSessionStart(call);
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
