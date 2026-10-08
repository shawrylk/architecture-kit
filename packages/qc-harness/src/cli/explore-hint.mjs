#!/usr/bin/env node
// The trigger for `swarm.explore`'s search and output hints: a long Grep answer names the repository's tools,
// and a long successful command output is saved to a file and shown as an excerpt, or named to the summarizer.

import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exploreSettingsAt } from "./dispatch.mjs";

const FAILURE_LINE = /\b(?:fail(?:s|ed|ure|ing)?|errors?|not ok|panic|exception)\b|✖/i;
const MAX_SIGNAL_LINES = 20;
const MAX_SIGNAL_CHARS = 200;
const fileSafe = (id) => String(id).replace(/[^A-Za-z0-9_.-]/g, "_");

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
    return JSON.stringify(response, null, 1);
  } catch {
    return "";
  }
}

/** Real newlines plus escaped `\n` sequences, the way a pretty-printed fallback hides them. */
function lineCountOf(text) {
  if (text === "") return 0;
  const realNewlines = (text.match(/\n/g) ?? []).length;
  const escapedNewlines = (text.match(/\\n/g) ?? []).length;
  return realNewlines + escapedNewlines + 1;
}

const grepHint = (tools) =>
  `Explore hint: this Grep answer runs long. Optional explore tools: ` +
  `${tools.map((tool) => tool.name).join(", ")}. Grep and shell searches remain available.`;

const outputHint = (summarizer) => `Explore hint: this output runs long. Pipe it through the summarizer instead: ${summarizer}`;

/** The head, the failure-shaped lines between, and the tail of a long output, in about `size` characters. */
export function excerptOf(text, size) {
  const headSize = Math.floor(size / 4);
  const tailStart = text.length - (size - headSize);
  const middle = text.slice(headSize, tailStart);
  const signal = middle
    .split(/\r?\n/)
    .filter((line) => FAILURE_LINE.test(line))
    .slice(0, MAX_SIGNAL_LINES)
    .map((line) => line.slice(0, MAX_SIGNAL_CHARS));
  return { head: text.slice(0, headSize), signal, tail: text.slice(tailStart), omitted: middle.length };
}

const askLine = (summarizer, file) =>
  summarizer === null ? "" : ` Ask the summarizer: ${summarizer.includes("<command>") ? summarizer.replace("<command>", `cat "${file}"`) : summarizer}.`;

/** What Claude sees in place of a long output: the excerpt, with a line that names the saved file. */
export function excerptText(text, size, file, summarizer) {
  const { head, signal, tail, omitted } = excerptOf(text, size);
  const found = signal.length > 0 ? ` Its lines that name a failure or an error:\n${signal.join("\n")}` : "";
  return `${head}\n[Explore excerpt: ${omitted} characters of this output are left out here, and the whole output is in ${file}. Read a range of it or search it.${askLine(summarizer, file)}${found}]\n${tail}`;
}

/** The tool output with its text replaced, in the same shape, or null for an image or a shape the hook does not know. */
export function replacedOutput(response, replacement) {
  if (typeof response === "string") return replacement;
  if (response === null || typeof response !== "object" || response.isImage === true) return null;
  if (typeof response.stdout === "string" || typeof response.stderr === "string") return { ...response, stdout: replacement, stderr: "" };
  if (typeof response.output === "string") return { ...response, output: replacement };
  return null;
}

/** Saves the whole output and shows its excerpt. @returns the hook output, or null when either step cannot run */
function excerptOutput(call, text, settings, tmp) {
  if (replacedOutput(call.tool_response, "") === null) return null;
  const scratch = typeof call.scratchpad_dir === "string" && call.scratchpad_dir !== "" ? call.scratchpad_dir : null;
  const dir = scratch ? path.join(scratch, "outputs") : path.join(tmp, "architecture-kit", "outputs", fileSafe(call.session_id ?? "session"));
  const file = path.join(dir, `${fileSafe(call.tool_use_id ?? Date.now())}.txt`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text);
  } catch {
    // A folder the hook cannot write leaves the output whole, with the hint.
    return null;
  }
  const replaced = replacedOutput(call.tool_response, excerptText(text, settings.excerptChars, file, settings.summarizer));
  return { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: replaced } };
}

/** The verdict on one finished Grep, Bash, or PowerShell call. @returns the hook output, or null for no change. */
export function decide(call, tmp = os.tmpdir()) {
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
    return settings.tools.length > 0 && lineCountOf(text) > settings.maxGrepLines ? context(grepHint(settings.tools)) : null;
  }

  if (text.length <= settings.maxOutputChars) return null;
  // Only an output at least twice the excerpt shrinks enough to be worth a file.
  if (settings.longOutput === "excerpt" && text.length > 2 * settings.excerptChars) {
    const excerpt = excerptOutput(call, text, settings, tmp);
    if (excerpt) return excerpt;
  }
  return settings.summarizer === null ? null : context(outputHint(settings.summarizer));
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
