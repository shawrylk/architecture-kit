#!/usr/bin/env node
// The branch for long Read calls adds advice while leaving the read available.

import { closeSync, existsSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globMatcher } from "../glob.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { exploreSettingsAt, exploreToolLines } from "./dispatch.mjs";

const BINARY_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "ipynb"]);
const SNIFF_BYTES = 8192;

const output = (fields) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", ...fields } });
const context = (text) => output({ additionalContext: text });

// Canonical paths keep checkout and exemption checks consistent across symlinks and alternate spellings.
function realOf(resolved) {
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isBinaryByExtension(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/** A NUL byte in the first 8 KB, cheaply, the same signal `file`-type tools use. False on a read error. */
function isBinaryByContent(file) {
  let fd;
  try {
    fd = openSync(file, "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const read = readSync(fd, buf, 0, buf.length, null);
    return buf.subarray(0, read).includes(0);
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/** True once more than `maxLines` newlines are seen, reading in chunks and stopping early. False on a read error. */
function exceedsLineBudget(file, maxLines) {
  let fd;
  try {
    fd = openSync(file, "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(64 * 1024);
    let count = 0;
    for (;;) {
      const read = readSync(fd, buf, 0, buf.length, null);
      if (read === 0) return false;
      for (let i = 0; i < read; i += 1) {
        if (buf[i] === 10) {
          count += 1;
          if (count > maxLines) return true;
        }
      }
    }
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

function readHint(tools) {
  const lines = ["Explore hint: this whole-file read runs long. The read can proceed."];
  if (tools.length > 0) lines.push("Optional explore tools:", ...exploreToolLines(tools));
  lines.push("For a shorter read, you can use offset and limit.");
  return lines.join("\n");
}

/** The verdict on one Read call. @returns the hook output, or null to let the call run with no message. */
export function decide(call) {
  if (call.hook_event_name !== "PreToolUse" || call.tool_name !== "Read") return null;
  const input = call.tool_input ?? {};
  const filePath = input.file_path;
  if (typeof filePath !== "string" || filePath === "") return null;

  let settings;
  try {
    settings = exploreSettingsAt(call.cwd ?? process.cwd());
  } catch (error) {
    // A config typo must not stop every read; the session sees the error and reports it.
    return context(`Explore hint is off: ${error.message}`);
  }
  if (!settings) return null;

  const cwd = call.cwd ?? process.cwd();
  const absolute = path.resolve(cwd, filePath);
  if (!existsSync(absolute)) return null;
  const realAbsolute = realOf(absolute);

  const root = checkoutRootOf(path.dirname(realAbsolute));
  // A file in no checkout, or in a checkout other than the session's own, is not this one to judge.
  if (!root || root !== checkoutRootOf(realOf(cwd))) return null;
  const rel = path.relative(root, realAbsolute).split(path.sep).join("/");
  if (globMatcher(settings.exempt)(rel)) return null;

  if (input.offset !== undefined || input.limit !== undefined) return null;
  if (isBinaryByExtension(realAbsolute) || isBinaryByContent(realAbsolute)) return null;
  if (!exceedsLineBudget(realAbsolute, settings.maxReadLines)) return null;

  return context(readHint(settings.tools));
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
