// The resource for a subagent's hand-back report, kept from the SubagentHandback call to the SubagentStop
// that follows it, since that stop's `last_assistant_message` holds only the closing text.

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileSafe } from "./edit-batch-state.mjs";

const reportFileOf = (sessionId, agentId, tmp) =>
  path.join(tmp, "architecture-kit", "reports", fileSafe(sessionId), `${fileSafe(agentId)}.txt`);

const MAX_REPORT_BYTES = 256 * 1024;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Keeps the end of an oversized text, which holds the verdict and the closing lines. */
function tailOf(text) {
  const bytes = Buffer.from(text);
  if (bytes.length <= MAX_REPORT_BYTES) return text;
  let start = bytes.length - MAX_REPORT_BYTES;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function sweep(tmp) {
  const root = path.join(tmp, "architecture-kit", "reports");
  for (const session of readdirSync(root, { withFileTypes: true })) {
    if (!session.isDirectory()) continue;
    const dir = path.join(root, session.name);
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (Date.now() - statSync(file).mtimeMs > MAX_AGE_MS) rmSync(file, { force: true });
    }
  }
}

/** Never throws: a report that cannot be kept leaves the stop to judge its last message. */
export function keepReport(sessionId, agentId, text, tmp) {
  try {
    const file = reportFileOf(sessionId, agentId, tmp);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, tailOf(text));
    sweep(tmp);
  } catch {
    // fail open
  }
}

/** @returns the kept report, or null when the agent sent none or the file cannot be read. */
export function keptReport(sessionId, agentId, tmp) {
  try {
    return readFileSync(reportFileOf(sessionId, agentId, tmp), "utf8");
  } catch {
    return null;
  }
}

export function dropReport(sessionId, agentId, tmp) {
  try {
    rmSync(reportFileOf(sessionId, agentId, tmp), { force: true });
  } catch {
    // fail open
  }
}

/** The report of a stopping subagent: the hand-back it sent, or else its last message. */
export function reportOf(call, tmp) {
  const agentId = typeof call.agent_id === "string" && call.agent_id !== "" ? call.agent_id : null;
  const kept = agentId ? keptReport(call.session_id ?? "session", agentId, tmp) : null;
  return kept ?? (typeof call.last_assistant_message === "string" ? call.last_assistant_message : "");
}
