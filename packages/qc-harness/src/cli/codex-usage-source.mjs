// Source proof: openai/codex 3d86e43b (0.172.0), core/src/session/mod.rs:5822-5967,6072-6079; app-server-protocol/src/protocol/v2/thread.rs:2220.
import { withCodexRollout } from "./codex-rollout-identity.mjs";
import { normalizeCodexContext } from "./codex-context.mjs";
import { normalizeUsage } from "./codex-usage.mjs";
import { codexAdmissionOf } from "./codex-runtime.mjs";
import { createHash } from "node:crypto";

const TAIL = 262144, MAX_LINES = 1024;
const receipts = new WeakMap();
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const usageUnknown = reason => { throw Error(`Owned usage UNKNOWN/refused${reason ? `: ${reason}` : ""}`); };
const ownedProof = (admission, input) => { try { return codexAdmissionOf(admission, input); } catch { return usageUnknown(); } };
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
    case "session_meta": return true; // The common boundary validates the only permitted header.
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

// C2a1: bounded entire-prefix verification. Larger histories need a separately proved producer.
export function createOwnedUsageSource(input, { admission, codexHome, proof }, binding) {
  const selected = Object.freeze({ cwd: input.cwd, session_id: input.session_id, transcript_path: input.transcript_path });
  if (!proof?.identityProvenance || ownedProof(admission, input) !== proof) usageUnknown();
  let cursor = null;
  return (call, options) => {
    if (options.admission !== admission || options.codexHome !== codexHome ||
        Object.keys(selected).some(key => call[key] !== selected[key]) || ownedProof(admission, call) !== proof) usageUnknown();
    const segment = withCodexRollout({ transcriptPath: selected.transcript_path, checkout: selected.cwd, threadId: selected.session_id },
      { codexHome }, ({ meta, first, source, before, key, decoder, read, validRow }) => {
        const original = proof.identityProvenance.fileIdentity;
        if (source !== "exec" || meta.session_id !== proof.nativeRootSessionId || key !== original.file ||
            Date.parse(first.timestamp) !== original.timestamp || first.ordinal !== original.ordinal || before.size > TAIL) return null;
        const bytes = read(0, before.size), headerEnd = bytes.indexOf(10) + 1;
        // No inferred fresh baseline from a restored/cumulative history at admission.
        if (original.bytes !== headerEnd) return { refusalReason: "original admission includes history" };
        if (bytes.at(-1) !== 10 || cursor &&
            (before.birthtimeMs !== cursor.birthtimeMs || before.size < cursor.bytes || digest(bytes.subarray(0, cursor.bytes)) !== cursor.digest)) return null;
        const lines = decoder.decode(bytes).slice(0, -1).split("\n");
        if (lines.length > MAX_LINES) return null;
        const deltas = [];
        let ordinal = first.ordinal - 1, timestamp = 0, offset = 0;
        for (const raw of lines) {
          const row = JSON.parse(raw), p = row.payload, start = offset;
          offset += Buffer.byteLength(raw) + 1;
          if (!validRow(row, timestamp, ordinal) || row.ordinal !== ordinal + 1 || !envelope(row) ||
              row.type === "session_meta" && start !== 0 || row.type === "event_msg" &&
              p.type === "thread_rolled_back") return null;
          if (row.type === "event_msg" && p.type === "token_count" && p.info == null)
            return { refusalReason: "verified response usage absent" };
          ordinal = row.ordinal; timestamp = Date.parse(row.timestamp);
          if (row.type !== "token_usage_record") continue;
          if (p.thread_id !== selected.session_id || p.session_id !== meta.session_id || p.root_turn_id !== p.turn_id) return null;
          if (start >= (cursor?.bytes ?? headerEnd)) deltas.push({ identity: JSON.stringify([p.session_id, p.thread_id, p.response_id]), usage: wire(p.usage) });
        }
        if (!cursor && !deltas.length) return { refusalReason: "verified response usage absent" };
        return { deltas, cursor: { bytes: before.size, birthtimeMs: before.birthtimeMs, digest: digest(bytes) } };
      });
    if (!segment) usageUnknown();
    if (segment.refusalReason) usageUnknown(segment.refusalReason);
    const receipt = Object.freeze({}), previous = cursor;
    receipts.set(receipt, { binding, apply: accept => {
      if (cursor !== previous || ownedProof(admission, selected) !== proof) usageUnknown();
      const result = accept(segment.deltas);
      cursor = segment.cursor;
      return result;
    } });
    return receipt;
  };
}

// Only producer-minted identities can deliver deltas; consumption and source cursor commit are atomic.
export function applyOwnedUsageReceipt(receipt, binding, accept) {
  const entry = receipts.get(receipt);
  if (!entry || entry.binding !== binding) throw Error("Owned usage receipt refused");
  receipts.delete(receipt);
  return entry.apply(accept);
}
// Supports local roots, profiled ThreadSpawn workers and registry-admitted exec workers; unsupported sources stay unknown.
/** On-demand local rollout only; no discovery, RPC, lifecycle changes, config resolution or persistent budget state. */
export function readCodexUsage(input, { role, admission, codexHome, now = Date.now(), previous } = {}) {
  try {
    const call = normalizeCodexContext(input, { role, admission });
    role = call.role;
    const proof = admission === undefined ? null : codexAdmissionOf(admission, input);
    return withCodexRollout({ transcriptPath: call.transcript_path, checkout: call.cwd, threadId: call.session_id }, { codexHome, now }, ({ meta, first, source, before, key, decoder, read, validRow }) => {
      if (previous && (previous.file !== key || !whole(previous.bytes) || previous.bytes > before.size || !whole(previous.timestamp) || !Number.isSafeInteger(previous.ordinal) || previous.ordinal < -1)) return null;
      const spawn = meta.source?.subagent?.thread_spawn;
      if (proof ? source !== "exec" || meta.session_id !== proof.nativeRootSessionId || key !== proof.identityProvenance?.fileIdentity.file ||
        Date.parse(first.timestamp) !== proof.identityProvenance.fileIdentity.timestamp || first.ordinal !== proof.identityProvenance.fileIdentity.ordinal :
        role === "leader" ? source === "thread_spawn" || meta.session_id !== meta.id :
        source !== "thread_spawn" || spawn.agent_role !== call.agent_type || meta.session_id === meta.id) return null;
      const start = Math.max(0, before.size - TAIL), tail = read(start, before.size - start);
      if (tail.at(-1) !== 10) return null;
      const skip = start ? tail.indexOf(10) + 1 : 0;
      if (start && !skip) return null;
      const lines = decoder.decode(tail.subarray(skip)).trimEnd().split("\n");
      if (lines.length > MAX_LINES) return null;
      let sample = null, candidate = null, timestamp = start ? Date.parse(first.timestamp) : 0, ordinal = start ? first.ordinal : -1;
      for (const raw of lines) {
        const row = JSON.parse(raw), time = Date.parse(row.timestamp), payload = row.payload;
        if (!validRow(row, timestamp, ordinal) || !envelope(row) || row.type === "session_meta" && row.ordinal !== first.ordinal) return null;
        timestamp = time;
        ordinal = row.ordinal;
        // Durable token_count drops Event.id. Bind its stored context to the adjacent,
        // fresh response identity; spending-only records cannot establish context alone.
        if (row.type === "event_msg" && payload.type === "token_count") {
          const last = wire(payload.info?.last_token_usage), response = wire(candidate?.usage);
          if (!candidate || !last || Object.keys(fields).concat("cacheWriteInputTokens").some(key => last[key] !== response[key])) {
            sample = candidate = null;
            continue;
          }
          sample = { method: "thread/tokenUsage/updated", params: { threadId: candidate.thread_id, turnId: candidate.turn_id,
            tokenUsage: { last, total: wire(payload.info.total_token_usage) } } };
          if (!normalizeUsage(sample)) return null;
          continue;
        }
        sample = candidate = null;
        if (row.type !== "token_usage_record") continue;
        if (payload?.thread_id !== call.session_id || payload.turn_id !== call.turn_id) { sample = null; continue; }
        if (payload.session_id !== meta.session_id || !id(payload.response_id) || !id(payload.root_turn_id) ||
            (proof || role === "leader") && payload.root_turn_id !== call.turn_id) return null;
        if (now - time > 120000) { sample = null; continue; }
        candidate = payload;
      }
      if (previous && (timestamp < previous.timestamp || ordinal < previous.ordinal)) return null;
      return sample ? { usage: sample, rootSessionId: meta.session_id, provenance: "codex-0.172.0/token_count+token_usage_record", cursor: { file: key, bytes: before.size, timestamp, ordinal } } : null;
    });
  } catch {
    return null;
  }
}
