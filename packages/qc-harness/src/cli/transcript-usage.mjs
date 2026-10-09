// The reader of Claude Code transcripts that the context signal and `qc tokens` share. It keeps only
// the usage, id, model, and time of each assistant request, once per request, and never message text.

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import path from "node:path";

export const WINDOW_BYTES = 256 * 1024;
const SYNTHETIC = "<synthetic>";

/** The input tokens one request sent: fresh input, cache reads, and cache writes. */
export const contextOf = (usage) =>
  (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0);

/** One transcript line as an assistant request with usage, or null for any other line. */
export function requestOf(line) {
  if (typeof line !== "string" || !line.includes('"usage"')) return null;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  const message = record?.message;
  if (record?.type !== "assistant" || !message?.usage || message.model === SYNTHETIC) return null;
  const at = Date.parse(record.timestamp ?? "");
  return { id: message.id ?? record.requestId ?? null, model: message.model ?? null, at: Number.isNaN(at) ? null : at, usage: message.usage };
}

/** Every request of a transcript, in order, once per id. @returns [] for a file that does not read */
export function readRequests(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const seen = new Set();
  const requests = [];
  for (const line of text.split(/\r?\n/)) {
    const request = requestOf(line);
    if (!request) continue;
    if (request.id !== null) {
      if (seen.has(request.id)) continue;
      seen.add(request.id);
    }
    requests.push(request);
  }
  return requests;
}

/** The whole lines of one window at the head or the tail of a file, or [] when it does not read. */
function windowLines(file, fromEnd, bytes) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(bytes, size);
    const start = fromEnd ? size - length : 0;
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    const lines = buffer.subarray(0, read).toString("utf8").split(/\r?\n/);
    // A window that starts or ends inside a line holds half of it, and half a line is no record.
    if (fromEnd && start > 0) lines.shift();
    if (!fromEnd && length < size) lines.pop();
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The usage of the first request in the head window, or null. */
export function firstUsage(file, bytes = WINDOW_BYTES) {
  for (const line of windowLines(file, false, bytes)) {
    const request = requestOf(line);
    if (request) return request.usage;
  }
  return null;
}

/** The usage of the last request in the tail window, or null. */
export function lastUsage(file, bytes = WINDOW_BYTES) {
  const lines = windowLines(file, true, bytes);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const request = requestOf(lines[index]);
    if (request) return request.usage;
  }
  return null;
}

/** The text of the first user message in the head window, which for a subagent is its dispatch prompt, or null. */
export function firstPromptOf(file, bytes = WINDOW_BYTES) {
  for (const line of windowLines(file, false, bytes)) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== "user" && record?.message?.role !== "user") continue;
    const content = record.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n");
    return null;
  }
  return null;
}

/** The transcript of subagent `agentId`, in the folder Claude Code keeps beside the main transcript. */
export const subagentTranscriptOf = (mainTranscript, agentId) =>
  path.join(path.dirname(mainTranscript), path.basename(mainTranscript, ".jsonl"), "subagents", `agent-${agentId}.jsonl`);

/** The transcript of the subagent a hook call runs in, or null for the main session or when no file exists. */
export function agentTranscriptOf(call) {
  const agentId = call?.agent_id;
  if (typeof agentId !== "string" || agentId === "") return null;
  const own = call.agent_transcript_path;
  if (typeof own === "string" && own !== "" && existsSync(own)) return own;
  const main = call.transcript_path;
  if (typeof main !== "string" || main === "") return null;
  if (path.basename(main) === `agent-${agentId}.jsonl`) return main;
  const derived = subagentTranscriptOf(main, agentId);
  return existsSync(derived) ? derived : null;
}

/** The agent type in the `.meta.json` beside a subagent transcript, or null. */
export function agentTypeOf(transcript) {
  try {
    const meta = JSON.parse(readFileSync(transcript.replace(/\.jsonl$/, ".meta.json"), "utf8"));
    return typeof meta?.agentType === "string" && meta.agentType !== "" ? meta.agentType : null;
  } catch {
    return null;
  }
}

/** The number of distinct tool calls in a transcript: each `tool_use` block counts once, whatever lines repeat its message. */
export function toolCallsIn(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return 0;
  }
  const ids = new Set();
  let anonymous = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('"tool_use"')) continue;
    let content;
    try {
      content = JSON.parse(line)?.message?.content;
    } catch {
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "tool_use") continue;
      if (typeof block.id === "string") ids.add(block.id);
      else anonymous += 1;
    }
  }
  return ids.size + anonymous;
}
