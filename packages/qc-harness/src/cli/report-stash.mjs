// The resource for a subagent's hand-back report, kept from the SubagentHandback call to the SubagentStop
// that follows it, since that stop's `last_assistant_message` holds only the closing text.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileSafe } from "./edit-batch-state.mjs";

const reportFileOf = (sessionId, agentId, tmp) =>
  path.join(tmp, "architecture-kit", "reports", fileSafe(sessionId), `${fileSafe(agentId)}.txt`);

export function keepReport(sessionId, agentId, text, tmp) {
  const file = reportFileOf(sessionId, agentId, tmp);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** @returns the kept report, or null when the agent sent none. */
export function keptReport(sessionId, agentId, tmp) {
  try {
    return readFileSync(reportFileOf(sessionId, agentId, tmp), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export const dropReport = (sessionId, agentId, tmp) => rmSync(reportFileOf(sessionId, agentId, tmp), { force: true });

/** The report of a stopping subagent: the hand-back it sent, or else its last message. */
export function reportOf(call, tmp) {
  const agentId = typeof call.agent_id === "string" && call.agent_id !== "" ? call.agent_id : null;
  const kept = agentId ? keptReport(call.session_id ?? "session", agentId, tmp) : null;
  return kept ?? (typeof call.last_assistant_message === "string" ? call.last_assistant_message : "");
}
