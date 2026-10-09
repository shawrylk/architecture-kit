#!/usr/bin/env node
// The SessionStart trigger for `swarm.dispatch`: one short note at each start, resume, clear, compaction
// and fork, because a rule held only in the conversation is lost to a compaction.

import { fileURLToPath } from "node:url";
import { directSettingsAt } from "./direct-lane.mjs";
import { dispatchSettingsAt, exploreSettingsAt, exploreToolLines } from "./dispatch.mjs";

export const REMINDER =
  "Subagent workflow (swarm.dispatch in qc.config.json): run a plan with superpowers:subagent-driven-development. " +
  "Dispatch architecture:sdd-planner to write a plan, architecture:sdd-implementer for one task, and " +
  "architecture:sdd-reviewer to review it; before merge, dispatch architecture:sdd-branch-reviewer to review the " +
  "whole branch. " +
  "Run one implementer at a time: a hook refuses a second. Name a model on any other dispatch, and " +
  "write each brief to a file and name its path on a prompt line `Brief: <path>`; a dispatch with no such line, or a missing file, is refused. " +
  "Name the worktree on a prompt line `Worktree: <path>`; a reviewer whose worktree, branch, or head the gate cannot read is refused. A reviewer starts with " +
  "`VERDICT: <APPROVED|CHANGES_REQUIRED> <sha>`, and a merge passes `--match-head-commit <sha>`. " +
  "Ask the user the product questions first, in one question, and record the answers under `## Product decisions` in each brief. " +
  "Review a head only once CI on it is green, with the base merged in: fix a CI failure first, and merge `origin/<base>` at Step 0 of a fix round. " +
  "A PR gets one branch review. After it, review each fix round once, by its increment: add `Reviewed: <sha>`, the last head a branch review named.";

const ROLES = ["sdd-planner", "sdd-implementer", "sdd-reviewer", "sdd-branch-reviewer"];

/** One added line naming each role's models for the session's runtime, so a dispatch names the right one. */
export function modelsLine({ models, runtime }) {
  const roles = ROLES.map((role) => `${role} ${(models[`architecture:${role}`] ?? models[role] ?? models["*"] ?? ["the session's model"]).join(" or ")}`);
  const how = runtime === "claude" ? "Name that model on each dispatch: the guard refuses a role dispatch with no model." : "A role with no named model inherits the session's.";
  const where = runtime ? `the ${runtime} runtime` : "an unknown runtime (set QC_RUNTIME to claude or codex)";
  return ` Models for ${where}: ${roles.join(", ")}. ${how}`;
}

const context = (eventName, text) => ({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } });

/** One added line for a limit above 1, which overrides the one-at-a-time rule of the note. */
const slotsLine = ({ implementerSlots }) =>
  implementerSlots > 1
    ? ` This repository allows up to ${implementerSlots} implementers at once, each in its own worktree, so the one-at-a-time rule above does not apply. A hook refuses one over the limit.`
    : "";

/** One added line for the direct lane of `swarm.direct`, or "" when it is off. */
function directLine(cwd) {
  let direct;
  try {
    direct = directSettingsAt(cwd);
  } catch (error) {
    return ` Direct lane is off: ${error.message}`;
  }
  return direct
    ? ` A fix of at most ${direct.maxLines} changed lines in ${direct.maxFiles} ${direct.maxFiles === 1 ? "file" : "files"} needs no subagent: edit it in the main session on a branch, ` +
        `and merge it with \`--match-head-commit <sha>\`${reviewClause(direct.reviewPaths)} The guards measure the branch against its base (swarm.direct).`
    : "";
}

/** The end of the merge sentence: no review, or the one APPROVED review that `swarm.direct.reviewPaths` asks for. */
function reviewClause(reviewPaths) {
  if (reviewPaths.length === 0) return " and no review.";
  if (reviewPaths.includes("**")) return ". Every direct merge needs one APPROVED review of the head (sdd-reviewer).";
  return ". A merge needs one APPROVED review of the head (sdd-reviewer) when a changed path matches swarm.direct.reviewPaths.";
}

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
  return tools ? ` Optional explore tools: ${tools.map((tool) => tool.name).join(", ")}. Read, Grep, and shell searches remain available.` : "";
}

/** A subagent may carry no MCP tool, so its note gives each tool's command, not only its name. */
function decideSubagentStart(cwd) {
  const tools = exploreToolsAt(cwd);
  if (!tools) return null;
  const lines = ["Optional explore tools, and how to run each. Read, Grep, and shell searches remain available:", ...exploreToolLines(tools)];
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
  return context("SessionStart", `${REMINDER}${modelsLine(dispatch)}${slotsLine(dispatch)}${directLine(cwd)}${explore}`);
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
