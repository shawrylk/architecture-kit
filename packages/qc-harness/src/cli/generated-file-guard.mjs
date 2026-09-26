#!/usr/bin/env node
// The PreToolUse trigger that refuses a hand edit of a generated file, or of a generated region of a
// Markdown file, and names the command that writes it. That command writes through the shell, never here.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE, load } from "../config.mjs";
import { generatedRegions } from "../generated-markers.mjs";
import { globMatcher } from "../glob.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
const MARKDOWN = /\.mdx?$/i;
const lf = (text) => text.replace(/\r\n/g, "\n");

const deny = (reason) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});

/** True when any occurrence of `needle` overlaps a region. */
function touchesRegion(text, needle, regions) {
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    if (regions.some(([start, end]) => at < end && at + needle.length > start)) return true;
  }
  return false;
}

/** True when an Edit or MultiEdit changes text inside a generated region of the Markdown file. */
function editsRegion(file, input) {
  if (!existsSync(file)) return false;
  const text = lf(readFileSync(file, "utf8"));
  const regions = generatedRegions(text);
  if (regions.length === 0) return false;
  const edits = Array.isArray(input.edits) ? input.edits : [input];
  return edits.some((one) => typeof one?.old_string === "string" && one.old_string !== "" && touchesRegion(text, lf(one.old_string), regions));
}

/** The verdict on one edit. @returns the hook output, or null to let the call run with no message. */
export function decide(call) {
  const input = call.tool_input ?? {};
  if (!EDIT_TOOLS.has(call.tool_name) || typeof input.file_path !== "string" || input.file_path === "") return null;
  const file = path.resolve(call.cwd ?? process.cwd(), input.file_path);
  const root = checkoutRootOf(path.dirname(file));
  if (!root || !existsSync(path.join(root, CONFIG_FILE))) return null;

  let generated;
  try {
    generated = load(root).generated;
  } catch {
    // A config error is the edit guard's to name; this guard judges the path alone.
    return null;
  }
  const rel = path.relative(root, file).split(path.sep).join("/");
  const rerun = `Change its source, then run \`${generated.command}\`.`;
  if (globMatcher(generated.globs)(rel)) {
    return deny(`Generated-file guard: ${rel} is generated. ${rerun}`);
  }
  if (call.tool_name !== "Write" && MARKDOWN.test(rel) && editsRegion(file, input)) {
    return deny(`Generated-file guard: the edit changes the generated region of ${rel}. ${rerun}`);
  }
  return null;
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
  const output = call ? decide(call) : null;
  if (output) process.stdout.write(JSON.stringify(output));
}
