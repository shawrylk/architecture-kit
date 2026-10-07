#!/usr/bin/env node
// The SessionStart trigger for `swarm.dispatch`: one short note at each start, resume, clear, compaction
// and fork, because a rule held only in the conversation is lost to a compaction.

import { fileURLToPath } from "node:url";
import { dispatchSettingsAt, exploreSettingsAt, exploreToolLines } from "./dispatch.mjs";

export const REMINDER =
  "Subagent workflow (swarm.dispatch in qc.config.json): run a plan with superpowers:subagent-driven-development. " +
  "Dispatch architecture:sdd-planner to write a plan, architecture:sdd-implementer for one task, and " +
  "architecture:sdd-reviewer to review it; before merge, dispatch architecture:sdd-branch-reviewer to review the " +
  "whole branch. All four roles default to gpt-6.1-sol with high reasoning effort. " +
  "Run one implementer at a time: a hook refuses a second while one runs. Name a model on any other dispatch, and " +
  "pass each brief as a file path. Name the worktree on a prompt line `Worktree: <path>`. A reviewer starts with " +
  "`VERDICT: <APPROVED|CHANGES_REQUIRED> <sha>`, and a merge passes `--match-head-commit <sha>`.";

const context = (eventName, text) => ({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } });

/** One added line for a limit above 1, which overrides the one-at-a-time rule of the note. */
const slotsLine = ({ implementerSlots }) =>
  implementerSlots > 1
    ? ` This repository allows up to ${implementerSlots} implementers at once, each in its own worktree, so the one-at-a-time rule above does not apply. A hook refuses one over the limit.`
    : "";

/** The explore tools, or null when the section is off, names none, or does not parse. */
function exploreToolsAt(cwd) {
  let settings;
  try {
    settings = exploreSettingsAt(cwd);
  } catch {
    // The explore guard and hint each report their own config error; the notes stay unaffected.
    return null;
  }
  return settings && settings.tools.length > 0 ? settings.tools : null;
}

/** One added line naming `swarm.explore`'s tools, or "" when there are none. */
function exploreLine(cwd) {
  const tools = exploreToolsAt(cwd);
  return tools ? ` The repository's own explore tools: ${tools.map((tool) => tool.name).join(", ")}.` : "";
}

/** A subagent may carry no MCP tool, so its note gives each tool's command, not only its name. */
function decideSubagentStart(cwd) {
  const tools = exploreToolsAt(cwd);
  if (!tools) return null;
  const lines = ["The repository's own explore tools, and how to run each:", ...exploreToolLines(tools)];
  return context("SubagentStart", lines.join("\n"));
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
