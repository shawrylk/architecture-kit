#!/usr/bin/env node
// The trigger for `swarm.explore`'s read budget: PreToolUse on Read refuses a whole-file read of a
// long text file and names the repository's own tools. The same file read the same way passes on
// a second attempt, so a real need for the whole file costs one retry, never a standing exemption.

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globMatcher } from "../glob.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { exploreSettingsAt } from "./dispatch.mjs";
import { slotDirOf } from "./dispatch-slot.mjs";

const BINARY_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "ipynb"]);
const SNIFF_BYTES = 8192;
const REFUSED_SUFFIX = ".refused";
const MAX_REFUSED = 200;

const output = (fields) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", ...fields } });
const deny = (reason) => output({ permissionDecision: "deny", permissionDecisionReason: reason });
const context = (text) => output({ additionalContext: text });

/** The real path of `resolved`, so two spellings of one file or folder (a `..` segment, a
 * case-folded drive letter, a symlink) resolve to one, everywhere this guard compares or hashes a
 * path; falls back to `resolved` itself when the real path cannot be read. */
function realOf(resolved) {
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

// One marker file per refused path, named by its hash, never a shared list: two Read hooks of one
// batch each create their own marker, so neither call can lose the other's write.
const markerFileOf = (dir, realAbsolute) => path.join(dir, `${createHash("sha256").update(realAbsolute).digest("hex")}${REFUSED_SUFFIX}`);

/** Records one refusal. An existing marker (a concurrent refusal of the same path) is left as is. */
function recordRefusal(dir, realAbsolute) {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(markerFileOf(dir, realAbsolute), "", { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") return; // No memory of this refusal just refuses the next read again too.
  }
  capMarkers(dir);
}

/** True and consumed when `realAbsolute` was refused before: a second attempt passes, a third is refused anew. */
function consumeRefusal(dir, realAbsolute) {
  try {
    unlinkSync(markerFileOf(dir, realAbsolute));
    return true;
  } catch {
    return false; // ENOENT (never refused), or a race that already consumed it — either way, not refused now.
  }
}

/** Keeps at most `MAX_REFUSED` markers, dropping the oldest by mtime. Ignores a concurrent unlink of the same file. */
function capMarkers(dir) {
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(REFUSED_SUFFIX));
  } catch {
    return;
  }
  const dated = names
    .map((name) => {
      try {
        return { name, mtimeMs: statSync(path.join(dir, name)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const { name } of dated.slice(0, dated.length - MAX_REFUSED)) {
    try {
      unlinkSync(path.join(dir, name));
    } catch {
      // Already gone — another call raced this same cleanup, and the cap still holds.
    }
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

  const dir = slotDirOf(call.session_id ?? "session", tmp);
  if (consumeRefusal(dir, realAbsolute)) return null;

  recordRefusal(dir, realAbsolute);
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
