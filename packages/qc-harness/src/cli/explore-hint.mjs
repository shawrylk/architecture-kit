#!/usr/bin/env node
// The trigger for `swarm.explore`'s search and output hints: PostToolUse on Grep adds context naming
// the repository's own tools when the answer runs long, and PostToolUse on Bash or PowerShell adds
// context naming the summarizer when the output runs long. Neither refuses anything; both are a
// nudge the model can take or leave.

import { fileURLToPath } from "node:url";
import { exploreSettingsAt } from "./dispatch.mjs";

const context = (text) => ({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } });

/** The tool's own answer, as plain text, from whatever shape `tool_response` carries. */
function textOf(response) {
  if (typeof response === "string") return response;
  if (response === null || response === undefined) return "";
  if (typeof response.content === "string") return response.content;
  if (Array.isArray(response.content)) {
    return response.content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n");
  }
  if (typeof response.stdout === "string" || typeof response.stderr === "string") {
    return `${response.stdout ?? ""}${response.stderr ?? ""}`;
  }
  if (typeof response.output === "string") return response.output;
  try {
    return JSON.stringify(response);
  } catch {
    return "";
  }
}

const grepHint = (tools) =>
  `Explore hint: this Grep answer runs long. The repository's own tools may answer faster: ` +
  `${tools.map((tool) => tool.name).join(", ")}.`;

const outputHint = (summarizer) => `Explore hint: this output runs long. Pipe it through the summarizer instead: ${summarizer}`;

/** The verdict on one finished Grep, Bash, or PowerShell call. @returns the hook output, or null for no change. */
export function decide(call) {
  if (call.hook_event_name !== "PostToolUse") return null;
  const tool = call.tool_name;
  if (tool !== "Grep" && tool !== "Bash" && tool !== "PowerShell") return null;

  let settings;
  try {
    settings = exploreSettingsAt(call.cwd ?? process.cwd());
  } catch (error) {
    // A config typo must not stop every call; the session sees the error and reports it.
    return context(`Explore guard is off: ${error.message}`);
  }
  if (!settings) return null;

  const text = textOf(call.tool_response);
  if (tool === "Grep") {
    const lineCount = text === "" ? 0 : text.split("\n").length;
    return lineCount > settings.maxGrepLines ? context(grepHint(settings.tools)) : null;
  }

  if (settings.summarizer === null) return null;
  return text.length > settings.maxOutputChars ? context(outputHint(settings.summarizer)) : null;
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
