// Source proof: openai/codex rust-v0.172.0 history/src/rollout_payload.rs and core/src/session/mod.rs:5892-5913.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeCodexContext } from "./codex-context.mjs";
import { normalizeUsage } from "./codex-usage.mjs";

const HEAD = 65536, TAIL = 262144, MAX_LINES = 1024;
const whole = value => Number.isSafeInteger(value) && value >= 0;
const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const fields = { inputTokens: "input_tokens", cachedInputTokens: "cached_input_tokens", outputTokens: "output_tokens", reasoningOutputTokens: "reasoning_output_tokens", totalTokens: "total_tokens" };
const wire = value => value && Object.fromEntries(Object.entries(fields).map(([to, from]) => [to, value[from]]).concat([["cacheWriteInputTokens", value.cache_write_input_tokens === undefined ? 0 : value.cache_write_input_tokens]]));
const read = (fd, start, length) => {
  const buffer = Buffer.alloc(length);
  if (readSync(fd, buffer, 0, length, start) !== length) throw new Error("incomplete source");
  return buffer;
};

// Supports local CLI/exec/VSCode roots and explicitly profiled ThreadSpawn workers; forks, remote/compressed sources and absent ordinals stay unknown.
/** On-demand local rollout only; no discovery, RPC, lifecycle changes, config resolution or persistent budget state. */
export function readCodexUsage(input, { role, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), now = Date.now(), previous } = {}) {
  let fd;
  try {
    const call = normalizeCodexContext(input, { role });
    if (!Number.isSafeInteger(now) || !path.isAbsolute(call.transcript_path) || !call.transcript_path.endsWith(".jsonl")) return null;
    const root = realpathSync(path.join(codexHome, "sessions")), file = realpathSync(call.transcript_path);
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative) || lstatSync(call.transcript_path).isSymbolicLink()) return null;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile()) return null;
    const key = createHash("sha256").update(`${file}:${before.dev}:${before.ino}`).digest("hex");
    if (previous && (previous.file !== key || !whole(previous.bytes) || previous.bytes > before.size || !whole(previous.timestamp) || !Number.isSafeInteger(previous.ordinal) || previous.ordinal < -1)) return null;
    const head = read(fd, 0, Math.min(HEAD, before.size)), newline = head.indexOf(10);
    if (newline < 0) return null;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const first = JSON.parse(decoder.decode(head.subarray(0, newline))), meta = first.payload;
    if (first.type !== "session_meta" || meta?.cli_version !== "0.172.0" || meta.id !== call.session_id || !id(meta.session_id) ||
        meta.forked_from_id != null || meta.history_base != null || realpathSync(meta.cwd) !== realpathSync(call.cwd)) return null;
    const spawn = meta.source?.subagent?.thread_spawn;
    if (role === "leader" ? !["cli", "exec", "vscode"].includes(meta.source) || meta.session_id !== meta.id :
      !spawn || spawn.agent_role !== call.agent_type || !id(spawn.parent_thread_id) || !whole(spawn.depth) || spawn.depth < 1 || meta.session_id === meta.id) return null;
    const start = Math.max(0, before.size - TAIL), tail = read(fd, start, before.size - start);
    if (tail.at(-1) !== 10) return null;
    const skip = start ? tail.indexOf(10) + 1 : 0;
    if (start && !skip) return null;
    const lines = decoder.decode(tail.subarray(skip)).trimEnd().split("\n");
    if (lines.length > MAX_LINES) return null;
    let sample = null, timestamp = 0, ordinal = -1;
    for (const raw of lines) {
      const row = JSON.parse(raw), time = Date.parse(row.timestamp), payload = row.payload;
      if (typeof row.timestamp !== "string" || !Number.isFinite(time) || time < timestamp || time > now || !whole(row.ordinal) || row.ordinal <= ordinal) return null;
      timestamp = time;
      ordinal = row.ordinal;
      if (row.type === "compacted" || row.type === "turn_context" && payload?.turn_id !== call.turn_id ||
          row.type === "event_msg" && (["context_compacted", "thread_rolled_back", "task_complete", "turn_complete", "turn_aborted"].includes(payload?.type) ||
            ["task_started", "turn_started"].includes(payload?.type) && payload.turn_id !== call.turn_id)) sample = null;
      if (row.type !== "token_usage_record") continue;
      if (payload?.thread_id !== call.session_id || payload.turn_id !== call.turn_id) { sample = null; continue; }
      if (payload.session_id !== meta.session_id || !id(payload.response_id) || !id(payload.root_turn_id) ||
          role === "leader" && payload.root_turn_id !== call.turn_id) return null;
      if (now - time > 120000) { sample = null; continue; }
      const usage = { method: "thread/tokenUsage/updated", params: { threadId: payload.thread_id, turnId: payload.turn_id,
        tokenUsage: { last: wire(payload.usage), total: wire(payload.thread_token_usage) } } };
      if (!normalizeUsage(usage)) return null;
      sample = usage;
    }
    const after = fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        previous && (timestamp < previous.timestamp || ordinal < previous.ordinal)) return null;
    return sample ? { usage: sample, provenance: "codex-0.172.0/token_usage_record", cursor: { file: key, bytes: before.size, timestamp, ordinal } } : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
