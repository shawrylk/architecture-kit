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
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nativeTokens = value => object(value) && Object.values(fields).every(key => whole(value[key])) &&
  (value.cache_write_input_tokens === undefined || whole(value.cache_write_input_tokens)) &&
  value.cached_input_tokens <= value.input_tokens && value.reasoning_output_tokens <= value.output_tokens;
// Durable discriminators: rust-v0.172.0 rollout/src/policy.rs:82-165; other native variants remain unsupported.
const responses = new Set("additional_tools message agent_message reasoning local_shell_call function_call tool_search_call function_call_output tool_search_output custom_tool_call custom_tool_call_output web_search_call image_generation_call configuration_update compaction context_compaction".split(" "));
const events = new Set("item_completed token_count thread_goal_updated thread_rolled_back turn_aborted task_started turn_started task_complete turn_complete thread_settings_applied user_message agent_message agent_reasoning agent_reasoning_raw_content entered_review_mode exited_review_mode patch_apply_end context_compacted mcp_tool_call_end web_search_end image_generation_end sub_agent_activity".split(" "));
function envelope(row) {
  if (!object(row) || !object(row.payload)) return false;
  const p = row.payload;
  switch (row.type) {
    case "session_meta": return id(p.id) && id(p.session_id) && typeof p.cwd === "string" && p.cli_version === "0.172.0";
    case "token_usage_record": return [p.thread_id, p.session_id, p.turn_id, p.root_turn_id, p.response_id].every(id) &&
      [p.usage, p.turn_token_usage, p.thread_token_usage].every(nativeTokens);
    case "response_item": return responses.has(p.type) && (p.type !== "message" || typeof p.role === "string" && Array.isArray(p.content));
    case "turn_context": return p.turn_id == null || id(p.turn_id);
    case "compacted": return typeof p.message === "string";
    case "event_msg":
      if (!events.has(p.type)) return false;
      if (["task_started", "turn_started", "task_complete", "turn_complete"].includes(p.type)) return id(p.turn_id);
      if (p.type !== "token_count") return true;
      return (p.rate_limits == null || object(p.rate_limits)) && (p.info == null || object(p.info) &&
        nativeTokens(p.info.last_token_usage) && nativeTokens(p.info.total_token_usage) &&
        (p.info.model_context_window == null || whole(p.info.model_context_window)));
    default: return false;
  }
}
function rowMetadata(row, now, timestamp = 0, ordinal = -1) {
  const time = Date.parse(row.timestamp);
  return envelope(row) && typeof row.timestamp === "string" && Number.isFinite(time) &&
    time >= timestamp && time <= now && whole(row.ordinal) && row.ordinal > ordinal;
}
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
    if (!rowMetadata(first, now) || first.type !== "session_meta" || meta.id !== call.session_id ||
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
    let sample = null, timestamp = start ? Date.parse(first.timestamp) : 0, ordinal = start ? first.ordinal : -1;
    for (const raw of lines) {
      const row = JSON.parse(raw), time = Date.parse(row.timestamp), payload = row.payload;
      if (!rowMetadata(row, now, timestamp, ordinal) || row.type === "session_meta" && row.ordinal !== first.ordinal) return null;
      timestamp = time;
      ordinal = row.ordinal;
      // Only a well-shaped token_count may follow a sample without replacing it; it never supplies usage or refreshes its age.
      if (row.type !== "token_usage_record" && row.type !== "session_meta" &&
          !(row.type === "event_msg" && payload.type === "token_count" && payload.info != null)) sample = null;
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
