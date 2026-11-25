import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCodexUsage } from "./codex-usage-source.mjs";
import { normalizeUsage } from "./codex-usage.mjs";

const now = Date.parse("2026-11-26T10:00:00Z");
const line = (type, payload, ordinal = 1, time = now) => JSON.stringify({ timestamp: new Date(time).toISOString(), ordinal, type, payload }) + "\n";
const tokens = { input_tokens: 390000, cached_input_tokens: 300000, output_tokens: 10000, reasoning_output_tokens: 9000, total_tokens: 400000 };
const record = () => ({ thread_id: "thread", session_id: "thread", turn_id: "turn", root_turn_id: "turn", response_id: "response", usage: { ...tokens }, turn_token_usage: { ...tokens, total_tokens: 9000000 }, thread_token_usage: { ...tokens, total_tokens: 90000000 } });
function fixture(t, worker = false) {
  const home = mkdtempSync(path.join(os.tmpdir(), "qc-native-usage-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const directory = path.join(home, "sessions"); mkdirSync(directory);
  const file = path.join(directory, "rollout.jsonl");
  const meta = { id: "thread", session_id: worker ? "root" : "thread", cli_version: "0.172.0", cwd: home, source: worker ? { subagent: { thread_spawn: { parent_thread_id: "root", depth: 1, agent_role: "profile" } } } : "exec" };
  const usage = { ...record(), session_id: meta.session_id };
  const call = { hook_event_name: "PreToolUse", cwd: home, session_id: "thread", turn_id: "turn", tool_use_id: "call", transcript_path: file, ...(worker ? { agent_id: "thread", agent_type: "profile" } : {}) };
  const options = { role: worker ? "implementer" : "leader", codexHome: home, now };
  const save = (rows = line("token_usage_record", usage)) => writeFileSync(file, line("session_meta", meta, 0, now - 1000000) + rows);
  save(); return { home, file, meta, usage, call, options, save, read: (extra = {}) => readCodexUsage(call, { ...options, ...extra }) };
}

test("unavailable native usage stays unknown without transcript fallback", (t) => {
  const f = fixture(t);
  rmSync(f.file);
  writeFileSync(path.join(f.home, "claude-transcript.jsonl"), line("token_usage_record", f.usage));
  assert.equal(f.read(), null);
  assert.equal(readCodexUsage({}), null);
});

test("external exec roots cannot supply implementer or reviewer identity", (t) => {
  const f = fixture(t);
  for (const role of ["implementer", "reviewer"]) {
    assert.equal(f.read({ role }), null, role);
    assert.equal(readCodexUsage({ ...f.call, agent_id: "thread", agent_type: "profile" }, { ...f.options, role }), null, role);
  }
});

test("malformed or unsupported native envelopes invalidate prior verified usage", (t) => {
  const f = fixture(t);
  for (const [type, payload] of [
    ["event_msg", null], ["event_msg", {}], ["event_msg", { type: "unknown_native_event" }],
    ["event_msg", { type: "token_count", info: { last_token_usage: tokens } }],
    ["event_msg", { type: "token_count", info: { last_token_usage: tokens, total_token_usage: tokens, model_context_window: -1 } }],
    ["event_msg", { type: "task_started" }],
    ["unknown_native_record", {}], ["response_item", null], ["response_item", { type: "unknown_native_item" }],
    ["response_item", { type: "message", role: "assistant", content: null }], ["turn_context", null],
    ["token_usage_record", null], ["compacted", null],
  ]) {
    f.save(line("token_usage_record", f.usage) + line(type, payload, 2));
    assert.equal(f.read(), null, `${type}: ${JSON.stringify(payload)}`);
  }
});

test("incomplete token usage records cannot preserve a prior verified sample", (t) => {
  const f = fixture(t);
  for (const field of ["usage", "turn_token_usage", "thread_token_usage"]) {
    for (const value of [undefined, null, {}, { ...tokens, total_tokens: -1 }]) {
      f.save(line("token_usage_record", f.usage) + line("token_usage_record", { ...f.usage, [field]: value }, 2));
      assert.equal(f.read(), null, `${field}: ${JSON.stringify(value)}`);
    }
  }
});

test("later persisted response without usage invalidates context until a new verified record", (t) => {
  for (const worker of [false, true]) {
    const f = fixture(t, worker), first = f.read();
    const count = { type: "token_count", info: { last_token_usage: tokens, total_token_usage: f.usage.thread_token_usage }, rate_limits: null };
    appendFileSync(f.file, line("event_msg", count, 2));
    assert.ok(f.read({ previous: first.cursor }));
    appendFileSync(f.file, line("response_item", { type: "message", role: "assistant", content: [] }, 3));
    appendFileSync(f.file, line("event_msg", count, 4));
    assert.equal(f.read({ previous: first.cursor }), null);
    appendFileSync(f.file, line("token_usage_record", { ...f.usage, response_id: "later" }, 5));
    assert.equal(normalizeUsage(f.read().usage).tokens, 400000);
    appendFileSync(f.file, line("event_msg", { type: "token_count", info: null, rate_limits: null }, 6));
    assert.equal(f.read(), null);
  }
});

test("native file supplies verified usage including cache subsets once, never lifetime totals", (t) => {
  const f = fixture(t), result = f.read();
  assert.deepEqual(normalizeUsage(result.usage), { sessionId: "thread", turnId: "turn", tokens: 400000 });
  assert.equal(result.provenance, "codex-0.172.0/token_usage_record");
  assert.doesNotMatch(JSON.stringify(result), /rollout\.jsonl/);
  assert.equal(result.usage.params.tokenUsage.total.totalTokens, 90000000);
  assert.deepEqual(f.read({ previous: result.cursor }), result);
  appendFileSync(f.file, line("token_usage_record", { ...f.usage, response_id: "next" }, 2, now + 1));
  assert.ok(f.read({ now: now + 1, previous: result.cursor }));
  f.save(line("token_usage_record", { ...f.usage, turn_id: "previous" }) + line("token_usage_record", f.usage, 2));
  assert.ok(f.read());
  f.save(line("token_usage_record", f.usage, 1, now - 120001) + line("token_usage_record", f.usage, 2));
  assert.ok(f.read());
  assert.equal(f.read({ previous: { file: result.cursor.file, bytes: 0 } }), null);
});

test("worker thread and root session remain separate; wrong role and repository stay unknown", (t) => {
  const f = fixture(t, true);
  assert.equal(normalizeUsage(f.read().usage).sessionId, "thread");
  assert.equal(readCodexUsage({ ...f.call, agent_type: "other-profile" }, f.options), null);
  assert.ok(f.read({ role: "reviewer" }));
  assert.equal(f.read({ role: "leader" }), null);
  f.usage.session_id = "thread"; f.save(); assert.equal(f.read(), null);
  f.usage.session_id = "root"; f.meta.cwd = os.tmpdir(); f.save(); assert.equal(f.read(), null);
});

test("mismatched, stale, malformed and unsupported provenance is unknown", (t) => {
  const f = fixture(t);
  for (const [key, value] of [["thread_id", "other"], ["turn_id", "old"], ["session_id", "root"], ["response_id", null], ["root_turn_id", "old"]]) {
    f.save(line("token_usage_record", { ...f.usage, [key]: value })); assert.equal(f.read(), null, key);
  }
  for (const time of [now - 120001, now + 1]) {
    f.save(line("token_usage_record", f.usage, 1, time)); assert.equal(f.read(), null);
  }
  for (const change of [{ cli_version: "0.171.0" }, { id: "other" }, { source: "unknown" }, { forked_from_id: "parent" }]) {
    const before = { ...f.meta }; Object.assign(f.meta, change); f.save(); assert.equal(f.read(), null); Object.keys(f.meta).forEach(k => delete f.meta[k]); Object.assign(f.meta, before);
  }
  for (const usage of [null, { ...tokens, cached_input_tokens: 400001 }, { ...tokens, total_tokens: -1 }, { ...tokens, cache_write_input_tokens: null }]) {
    f.save(line("token_usage_record", { ...f.usage, usage })); assert.equal(f.read(), null);
  }
  for (const raw of ["private malformed\n", line("token_usage_record", f.usage).trimEnd(), line("event_msg", { type: "token_count", info: { last_token_usage: tokens } })]) {
    f.save(raw); assert.equal(f.read(), null);
  }
});

test("lifecycle invalidation and sample ordering prevent reuse across compaction and turns", (t) => {
  const f = fixture(t), first = f.read();
  for (const [type, payload] of [["compacted", {}], ["event_msg", { type: "context_compacted" }], ["event_msg", { type: "task_complete", turn_id: "turn" }], ["event_msg", { type: "turn_aborted", turn_id: "turn" }], ["event_msg", { type: "task_started", turn_id: "next" }], ["turn_context", { turn_id: "next" }]]) {
    f.save(line("token_usage_record", f.usage) + line(type, payload, 2)); assert.equal(f.read(), null, type);
  }
  f.save(line("token_usage_record", f.usage, 2) + line("token_usage_record", f.usage, 1)); assert.equal(f.read(), null);
  f.save(line("token_usage_record", f.usage, 1, now) + line("token_usage_record", f.usage, 2, now - 1)); assert.equal(f.read(), null);
  f.save(); appendFileSync(f.file, line("token_usage_record", { ...f.usage, response_id: "next" }, 2)); const newer = f.read();
  f.save(); assert.equal(f.read({ previous: newer.cursor }), null);
  assert.equal(f.read({ previous: { ...first.cursor, file: "another" } }), null);
  f.save(line("token_usage_record", f.usage, 1).replace('"ordinal":1,', "")); assert.equal(f.read(), null);
});

test("retained metadata outside the tail must have valid ordered row metadata", async (t) => {
  const f = fixture(t);
  const tail = line("response_item", { type: "reasoning", private: "x".repeat(600000) }) + line("token_usage_record", f.usage, 2, now - 1);
  const header = JSON.parse(line("session_meta", f.meta, 0, now - 1000000));
  for (const field of ["ordinal", "timestamp"]) {
    await t.test(`missing ${field}`, () => {
      const row = { ...header }; delete row[field];
      writeFileSync(f.file, JSON.stringify(row) + "\n" + tail);
      assert.equal(f.read(), null);
    });
  }
  for (const change of [{ ordinal: -1 }, { ordinal: 3 }, { timestamp: "invalid" }, { timestamp: new Date(now).toISOString() }, { timestamp: new Date(now + 1).toISOString() }]) {
    await t.test(JSON.stringify(change), () => {
      writeFileSync(f.file, JSON.stringify({ ...header, ...change }) + "\n" + tail);
      assert.equal(f.read(), null);
    });
  }
});

test("bounded head/tail reads support large rollouts and reject oversized metadata and scans", (t) => {
  const f = fixture(t);
  f.save(line("response_item", { private: "x".repeat(600000) }) + line("token_usage_record", f.usage, 2));
  assert.ok(f.read());
  f.meta.private = "x".repeat(70000); f.save(); assert.equal(f.read(), null); delete f.meta.private;
  const rows = Array.from({ length: 1023 }, (_, i) => line("event_msg", { type: "agent_message" }, i + 1)).join("");
  const padding = line("response_item", { type: "reasoning", private: "x".repeat(600000) });
  f.save(padding + rows + line("token_usage_record", f.usage, 1024)); assert.ok(f.read());
  f.save(padding + rows + line("event_msg", { type: "agent_message" }, 1024) + line("token_usage_record", f.usage, 1025)); assert.equal(f.read(), null);
  f.save(); const original = readFileSync(f.file); const outside = path.join(f.home, "outside.jsonl"); writeFileSync(outside, original);
  assert.equal(readCodexUsage({ ...f.call, transcript_path: outside }, f.options), null);
  const folder = path.join(f.home, "sessions", "folder.jsonl"); mkdirSync(folder);
  assert.equal(readCodexUsage({ ...f.call, transcript_path: folder }, f.options), null);
  if (process.platform !== "win32") {
    const alias = path.join(f.home, "sessions", "alias.jsonl"); symlinkSync(f.file, alias);
    assert.equal(readCodexUsage({ ...f.call, transcript_path: alias }, f.options), null);
  }
  f.save("private data\n"); assert.equal(f.read(), null);
});
