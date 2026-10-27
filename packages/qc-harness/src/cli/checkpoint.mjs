#!/usr/bin/env node
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE, load } from "../config.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { readState, writeState } from "./budget-counter.mjs";

export const HEADINGS = ["## Goal", "## Rules", "## Tasks", "## Next"];

export function checkpointPathOf(cwd, sessionId) {
  const root = checkoutRootOf(cwd);
  if (!root) return null;
  let git = path.join(root, ".git");
  if (statSync(git).isFile()) {
    const pointer = readFileSync(git, "utf8").trim();
    if (!pointer.startsWith("gitdir: ")) throw new Error("Invalid Git directory pointer");
    git = path.resolve(root, pointer.slice(8));
  }
  const common = path.join(git, "commondir");
  if (existsSync(common)) git = path.resolve(git, readFileSync(common, "utf8").trim());
  const session = String(sessionId ?? "session").replace(/[^A-Za-z0-9_-]/g, "_") || "session";
  return path.join(git, "qc", "checkpoints", `${session}.md`);
}

export function checkpointProblem(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const missing = HEADINGS.filter((heading) => !lines.includes(heading));
  if (missing.length) return `missing heading: ${missing.join(", ")}`;
  return lines.length > 80 ? "exceeds 80 non-blank lines" : null;
}

export function readCheckpoint(file, { maxAgeMinutes = 30, now = Date.now() } = {}) {
  try {
    const text = readFileSync(file, "utf8");
    const problem = checkpointProblem(text);
    if (problem) return { text, problem };
    const stale = maxAgeMinutes > 0 && now - statSync(file).mtimeMs > maxAgeMinutes * 60_000;
    return { text, problem: stale ? `older than ${maxAgeMinutes} minutes` : null };
  } catch (error) {
    return { text: null, problem: error.code === "ENOENT" ? "missing file" : `cannot read file (${error.code ?? "error"})` };
  }
}

export function checkpointSettingsAt(cwd) {
  const root = checkoutRootOf(cwd);
  return root && existsSync(path.join(root, CONFIG_FILE)) ? load(root).checkpoint : null;
}

// This reader limits each dispatch to the transcript's last 256 KiB.
function dispatchMessageOf(call) {
  if (!call.transcript_path || !call.tool_use_id) return null;
  let fd;
  try {
    fd = openSync(call.transcript_path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - 256 * 1024);
    const buffer = Buffer.alloc(size - start);
    const length = readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, length).toString("utf8").split(/\r?\n/);
    if (start) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      let record;
      try { record = JSON.parse(lines[i]); } catch { continue; }
      if (record.type !== "assistant") continue;
      if (record.message?.content?.some((block) => block.type === "tool_use" && block.id === call.tool_use_id)) {
        return typeof record.message.id === "string" ? record.message.id : null;
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return null;
}

export function checkpointRefusal(call, now = Date.now()) {
  const cwd = call.cwd ?? process.cwd();
  const settings = checkpointSettingsAt(cwd);
  if (!settings) return null;
  const file = checkpointPathOf(cwd, call.session_id);
  const message = dispatchMessageOf(call);
  const stateFile = `${file}.dispatch.json`;
  const state = message ? readState(stateFile) : {};
  const at = message && state.message === message && Number.isFinite(state.at) ? Math.min(now, state.at) : now;
  const checkpoint = readCheckpoint(file, { ...settings, now: at });
  if (checkpoint.problem) return `Checkpoint: ${file}\n${checkpoint.problem}. Update the file before dispatch.\nRequired headings: ${HEADINGS.join(", ")}.`;
  if (message && state.message !== message) {
    try { writeState(stateFile, { message, at: now }); } catch { /* A lost batch record keeps the age check strict. */ }
  }
  return null;
}

export function checkpointNote(file) {
  return `Checkpoint: ${file}\nWrite and update this file before dispatch and compaction. Use ${HEADINGS.join(", ")}; keep at most 80 non-blank lines.`;
}

export function decide(call) {
  if (call.hook_event_name !== "SessionStart" || call.agent_id) return null;
  const context = (additionalContext) => ({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } });
  let file;
  try {
    const cwd = call.cwd ?? process.cwd();
    if (!checkpointSettingsAt(cwd)) return null;
    file = checkpointPathOf(cwd, call.session_id);
    const note = checkpointNote(file);
    if (call.source !== "compact" && call.source !== "resume") return context(note);
    const checkpoint = readCheckpoint(file, { maxAgeMinutes: 0 });
    if (checkpoint.text === null) return context(`${note}\nCheckpoint: ${checkpoint.problem}.`);
    const header = `Checkpoint ${file} is the source of truth for open work.\n`;
    const cap = "\nCheckpoint print capped at 80 lines and 8,000 characters. Read the file for the rest.";
    const lines = checkpoint.text.split(/\r?\n/);
    const preview = lines.slice(0, 80).join("\n");
    const truncated = lines.length > 80 || header.length + preview.length > 8000;
    return context(header + (truncated ? preview.slice(0, Math.max(0, 8000 - header.length - cap.length)) + cap : preview));
  } catch (error) {
    return context(`Checkpoint${file ? ` ${file}` : ""}: cannot read (${String(error.message).replace(/[\r\n]+/g, " ")}).`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const result = decide(JSON.parse(input));
    if (result) process.stdout.write(JSON.stringify(result));
  } catch {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "Checkpoint: cannot read hook input." } }));
  }
}
