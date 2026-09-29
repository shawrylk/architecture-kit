#!/usr/bin/env node
// The trigger for `swarm.explore`'s read budget: PreToolUse on Read refuses a whole-file read of a
// long text file and names the repository's own tools. The same file read the same way passes on
// a second attempt, so a real need for the whole file costs one retry, never a standing exemption.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globMatcher } from "../glob.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { exploreSettingsAt } from "./dispatch.mjs";
import { slotDirOf } from "./dispatch-slot.mjs";

const BINARY_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "ipynb"]);
const SNIFF_BYTES = 8192;
const REFUSED_FILE = "explore-refused.json";
const MAX_REFUSED = 200;

const output = (fields) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", ...fields } });
const deny = (reason) => output({ permissionDecision: "deny", permissionDecisionReason: reason });
const context = (text) => output({ additionalContext: text });

const refusedFileOf = (dir) => path.join(dir, REFUSED_FILE);

/** The paths refused so far in one session, oldest first, capped at the last `MAX_REFUSED`. */
function readRefused(dir) {
  try {
    const data = JSON.parse(readFileSync(refusedFileOf(dir), "utf8"));
    return Array.isArray(data) ? data.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** Records one more refused path, never growing past `MAX_REFUSED`. Silent on a read-only temp folder. */
function recordRefusal(dir, absolute) {
  const kept = [...readRefused(dir), absolute].slice(-MAX_REFUSED);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(refusedFileOf(dir), JSON.stringify(kept));
  } catch {
    // No memory of this refusal just means the next read of the same path is refused again too.
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

function refusalMessage(tools) {
  const lines = tools.map((tool) => `- ${tool.name}: ${tool.use} (${tool.how})`);
  lines.push("Read a range with offset and limit, or read the same file again to read it whole.");
  return lines.join("\n");
}

/** The verdict on one Read call. @returns the hook output, or null to let the call run with no message. */
export function decide(call, tmp = os.tmpdir()) {
  if (call.hook_event_name !== "PreToolUse" || call.tool_name !== "Read") return null;
  const input = call.tool_input ?? {};
  const filePath = input.file_path;
  if (typeof filePath !== "string" || filePath === "") return null;

  let settings;
  try {
    settings = exploreSettingsAt(call.cwd ?? process.cwd());
  } catch (error) {
    // A config typo must not stop every read; the session sees the error and reports it.
    return context(`Explore guard is off: ${error.message}`);
  }
  if (!settings) return null;

  const absolute = path.resolve(call.cwd ?? process.cwd(), filePath);
  if (!existsSync(absolute)) return null;

  const root = checkoutRootOf(path.dirname(absolute));
  const rel = root ? path.relative(root, absolute).split(path.sep).join("/") : null;
  if (rel !== null && globMatcher(settings.exempt)(rel)) return null;

  if (input.offset !== undefined || input.limit !== undefined) return null;
  if (isBinaryByExtension(absolute) || isBinaryByContent(absolute)) return null;
  if (!exceedsLineBudget(absolute, settings.maxReadLines)) return null;

  const dir = slotDirOf(call.session_id ?? "session", tmp);
  if (readRefused(dir).includes(absolute)) return null;

  recordRefusal(dir, absolute);
  return deny(refusalMessage(settings.tools));
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
