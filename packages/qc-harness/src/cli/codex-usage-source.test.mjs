import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOwnedUsageSource, applyOwnedUsageReceipt, readCodexUsage } from "./codex-usage-source.mjs";
import { normalizeUsage } from "./codex-usage.mjs";

import { createCodexRuntime } from "./codex-runtime.mjs";
import { prepareOwnedTask } from "./codex-owned-task.mjs";
import { once } from "node:events";

const now = Date.parse("2026-11-26T10:00:00Z");
const line = (type, payload, ordinal = 1, time = now) => JSON.stringify({ timestamp: new Date(time).toISOString(), ordinal, type, payload }) + "\n";
const tokens = { input_tokens: 390000, cached_input_tokens: 300000, output_tokens: 10000, reasoning_output_tokens: 9000, total_tokens: 400000 };
const record = () => ({ thread_id: "thread", session_id: "thread", turn_id: "turn", root_turn_id: "turn", response_id: "response", usage: { ...tokens }, turn_token_usage: { ...tokens, total_tokens: 9000000 }, thread_token_usage: { ...tokens, total_tokens: 90000000 } });
const snapshot = (usage, ordinal = 2, time = now) => line("event_msg", { type: "token_count", info: {
  last_token_usage: usage.usage, total_token_usage: usage.thread_token_usage,
}, rate_limits: null }, ordinal, time);
const verified = (usage, ordinal = 1, time = now) => line("token_usage_record", usage, ordinal, time) + snapshot(usage, ordinal + 1, time);
function fixture(t, worker = false) {
  const home = mkdtempSync(path.join(os.tmpdir(), "qc-native-usage-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const directory = path.join(home, "sessions"); mkdirSync(directory);
  const file = path.join(directory, "rollout.jsonl");
  const meta = { id: "thread", session_id: worker ? "root" : "thread", cli_version: "0.172.0", cwd: home, source: worker ? { subagent: { thread_spawn: { parent_thread_id: "root", depth: 1, agent_role: "profile" } } } : "exec" };
  const usage = { ...record(), session_id: meta.session_id };
  const call = { hook_event_name: "PreToolUse", cwd: home, session_id: "thread", turn_id: "turn", tool_use_id: "call", transcript_path: file, ...(worker ? { agent_id: "thread", agent_type: "profile" } : {}) };
  const options = { role: worker ? "implementer" : "leader", codexHome: home, now };
  const save = (rows = verified(usage)) => writeFileSync(file, line("session_meta", meta, 0, now - 1000000) + rows);
  save(); return { home, file, meta, usage, call, options, save, read: (extra = {}) => readCodexUsage(call, { ...options, ...extra }) };
}

test("usage shares one descriptor and bounded head/tail reads, rejecting mid-read mutation", (t) => {
  const f = fixture(t), reads = [], original = fs.readSync;
  f.save(line("response_item", { type: "reasoning", private: "x".repeat(600000) }) + verified(f.usage, 2));
  const size = fs.statSync(f.file).size;
  let mutate = false;
  t.mock.method(fs, "readSync", (fd, buffer, offset, length, start) => {
    reads.push([fd, start, length]); const count = original(fd, buffer, offset, length, start);
    if (mutate && start) appendFileSync(f.file, "\n"); return count;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.ok(f.read()); assert.equal(reads.length, 2); assert.equal(reads[0][0], reads[1][0]);
  assert.deepEqual(reads.map(row => row.slice(1)), [[0, 65536], [size - 262144, 262144]]);
  mutate = true; assert.equal(f.read(), null);
});

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

test("JSON admission, role and root claims cannot authorize an external exec source", t => {
  const f = fixture(t);
  for (const admission of [{}, null, { role: "implementer", nativeRootSessionId: "thread", nativeThreadId: "thread", budget: null }]) {
    assert.equal(f.read({ admission }), null);
    assert.equal(readCodexUsage({ ...f.call, admission, role: "leader", parent: "trusted", settings: {} },
      { ...f.options, role: "implementer" }), null);
  }
});

test("incomplete-response spending cannot establish the context baseline", (t) => {
  const f = fixture(t);
  const baseline = { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 1010 };
  // The native producer persists spending, then emits the unchanged stored context.
  f.save(line("token_usage_record", f.usage) + line("event_msg", {
    type: "token_count", info: { last_token_usage: baseline, total_token_usage: f.usage.thread_token_usage }, rate_limits: null,
  }, 2));
  const result = f.read();
  assert.equal(result, null, "snapshot conflicts with current response spending");
  f.save(line("token_usage_record", f.usage));
  assert.equal(f.read(), null, "undifferentiated spending alone is unknown");
});

test("context snapshots require fresh adjacent current-turn identity evidence", (t) => {
  const f = fixture(t);
  for (const rows of [
    snapshot(f.usage, 1),
    line("token_usage_record", { ...f.usage, turn_id: "old" }) + snapshot(f.usage),
    line("token_usage_record", f.usage, 1, now - 120001) + snapshot(f.usage),
    line("token_usage_record", f.usage) + line("turn_context", { turn_id: "other" }, 2) + snapshot(f.usage, 3),
    verified(f.usage) + line("token_usage_record", { ...f.usage, response_id: "incomplete" }, 3),
    verified(f.usage) + line("token_usage_record", { ...f.usage, turn_id: "old" }, 3) + snapshot(f.usage, 4),
  ]) {
    f.save(rows); assert.equal(f.read(), null);
  }
  for (const field of Object.keys(tokens)) {
    const changed = { ...tokens, [field]: tokens[field] + 1 };
    f.save(line("token_usage_record", f.usage) + snapshot({ ...f.usage, usage: changed }));
    assert.equal(f.read(), null, field);
  }
  f.save(verified(f.usage) + snapshot(f.usage, 3, now + 120001));
  assert.equal(f.read({ now: now + 120001 }), null, "repeated snapshot cannot refresh an old response");
  const small = { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 1010 };
  f.save(verified({ ...f.usage, usage: small }));
  assert.equal(normalizeUsage(f.read().usage).tokens, 1010);
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
    f.save(verified(f.usage) + line(type, payload, 3));
    assert.equal(f.read(), null, `${type}: ${JSON.stringify(payload)}`);
  }
});

test("incomplete token usage records cannot preserve a prior verified sample", (t) => {
  const f = fixture(t);
  for (const field of ["usage", "turn_token_usage", "thread_token_usage"]) {
    for (const value of [undefined, null, {}, { ...tokens, total_tokens: -1 }]) {
      f.save(verified(f.usage) + line("token_usage_record", { ...f.usage, [field]: value }, 3));
      assert.equal(f.read(), null, `${field}: ${JSON.stringify(value)}`);
      f.save(verified(f.usage) + line("token_usage_record", { ...f.usage, [field]: value }, 3) + snapshot(f.usage, 4));
      assert.equal(f.read(), null, `${field}: incomplete candidate cannot gain validity from a following snapshot`);
    }
  }
});

test("later persisted response without usage invalidates context until a new verified record", (t) => {
  for (const worker of [false, true]) {
    const f = fixture(t, worker), first = f.read();
    assert.equal(first.rootSessionId, worker ? "root" : "thread");
    const count = { type: "token_count", info: { last_token_usage: tokens, total_token_usage: f.usage.thread_token_usage }, rate_limits: null };
    appendFileSync(f.file, line("event_msg", count, 3));
    assert.ok(f.read({ previous: first.cursor }));
    appendFileSync(f.file, line("response_item", { type: "message", role: "assistant", content: [] }, 4));
    appendFileSync(f.file, line("event_msg", count, 5));
    assert.equal(f.read({ previous: first.cursor }), null);
    appendFileSync(f.file, verified({ ...f.usage, response_id: "later" }, 6));
    assert.equal(normalizeUsage(f.read().usage).tokens, 400000);
    appendFileSync(f.file, line("event_msg", { type: "token_count", info: null, rate_limits: null }, 8));
    assert.equal(f.read(), null);
  }
});

test("native file supplies verified usage including cache subsets once, never lifetime totals", (t) => {
  const f = fixture(t), result = f.read();
  assert.deepEqual(normalizeUsage(result.usage), { sessionId: "thread", turnId: "turn", tokens: 400000 });
  assert.equal(result.provenance, "codex-0.172.0/token_count+token_usage_record");
  assert.doesNotMatch(JSON.stringify(result), /rollout\.jsonl/);
  assert.equal(result.usage.params.tokenUsage.total.totalTokens, 90000000);
  assert.deepEqual(f.read({ previous: result.cursor }), result);
  appendFileSync(f.file, verified({ ...f.usage, response_id: "next" }, 3, now + 1));
  assert.ok(f.read({ now: now + 1, previous: result.cursor }));
  f.save(line("token_usage_record", { ...f.usage, turn_id: "previous" }) + verified(f.usage, 2));
  assert.ok(f.read());
  f.save(line("token_usage_record", f.usage, 1, now - 120001) + verified(f.usage, 2));
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
    f.save(verified({ ...f.usage, [key]: value })); assert.equal(f.read(), null, key);
  }
  for (const time of [now - 120001, now + 1]) {
    f.save(verified(f.usage, 1, time)); assert.equal(f.read(), null);
  }
  for (const change of [{ cli_version: "0.171.0" }, { id: "other" }, { source: "unknown" }, { forked_from_id: "parent" }]) {
    const before = { ...f.meta }; Object.assign(f.meta, change); f.save(); assert.equal(f.read(), null); Object.keys(f.meta).forEach(k => delete f.meta[k]); Object.assign(f.meta, before);
  }
  for (const usage of [null, { ...tokens, cached_input_tokens: 400001 }, { ...tokens, total_tokens: -1 }, { ...tokens, cache_write_input_tokens: null }]) {
    f.save(verified({ ...f.usage, usage })); assert.equal(f.read(), null);
  }
  for (const raw of ["private malformed\n", line("token_usage_record", f.usage).trimEnd(), line("event_msg", { type: "token_count", info: { last_token_usage: tokens } })]) {
    f.save(raw); assert.equal(f.read(), null);
  }
});

test("lifecycle invalidation and sample ordering prevent reuse across compaction and turns", (t) => {
  const f = fixture(t), first = f.read();
  for (const [type, payload] of [["compacted", { message: "compacted" }], ["event_msg", { type: "context_compacted" }], ["event_msg", { type: "task_complete", turn_id: "turn" }], ["event_msg", { type: "turn_aborted", turn_id: "turn" }], ["event_msg", { type: "task_started", turn_id: "next" }], ["turn_context", { turn_id: "next" }]]) {
    f.save(verified(f.usage) + line(type, payload, 3)); assert.equal(f.read(), null, type);
  }
  f.save(verified(f.usage, 2) + verified(f.usage, 1)); assert.equal(f.read(), null);
  f.save(verified(f.usage, 1, now) + verified(f.usage, 3, now - 1)); assert.equal(f.read(), null);
  f.save(); appendFileSync(f.file, verified({ ...f.usage, response_id: "next" }, 3)); const newer = f.read();
  f.save(); assert.equal(f.read({ previous: newer.cursor }), null);
  assert.equal(f.read({ previous: { ...first.cursor, file: "another" } }), null);
  f.save(verified(f.usage, 1).replace('"ordinal":1,', "")); assert.equal(f.read(), null);
});

test("retained metadata outside the tail must have valid ordered row metadata", async (t) => {
  const f = fixture(t);
  const tail = line("response_item", { type: "reasoning", private: "x".repeat(600000) }) + verified(f.usage, 2, now - 1);
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
  f.save(line("response_item", { private: "x".repeat(600000) }) + verified(f.usage, 2));
  assert.ok(f.read());
  f.meta.private = "x".repeat(70000); f.save(); assert.equal(f.read(), null); delete f.meta.private;
  const rows = Array.from({ length: 1022 }, (_, i) => line("event_msg", { type: "agent_message" }, i + 1)).join("");
  const padding = line("response_item", { type: "reasoning", private: "x".repeat(600000) });
  f.save(padding + rows + verified(f.usage, 1023)); assert.ok(f.read());
  f.save(padding + rows + line("event_msg", { type: "agent_message" }, 1023) + verified(f.usage, 1024)); assert.equal(f.read(), null);
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

// Pinned session/mod.rs:5893-5913 persists per-response usage; :1853-1860 restores snapshots.
async function ownedFixture(t, initial = "") {
  t.mock.method(Date, "now", () => now);
  const f = fixture(t); f.save(initial); mkdirSync(path.join(f.home, ".git"));
  const executable = path.join(f.home, "native");
  writeFileSync(executable, '#!/bin/sh\nprintf \'{"type":"thread.started","thread_id":"thread"}\\n\'\ncat >/dev/null\n', { mode: 0o700 });
  const runtime = createCodexRuntime({ worktree: f.home, executable, workflowId: "usage", codexHome: f.home });
  const admission = runtime.reserve({ role: "implementer", workflowParentId: "parent" });
  const child = runtime.launch(admission), task = prepareOwnedTask({ deadline: Date.now() + 60000, policy: { provider: "codex" } });
  t.after(async () => { if (child.exitCode !== null || child.signalCode !== null) return; const ended = once(child, "exit"); child.stdin.end(); await ended; });
  task.admit(task.handle, 1); task.watch(child);
  await once(child, "spawn");
  runtime.startup(admission, admission.hookCredential, { ...f.call, hook_event_name: "SessionStart", source: "startup" });
  const proof = await runtime.ready(admission); task.running(proof);
  const options = { admission, codexHome: f.home };
  const usage = (amount, response = "first") => ({ ...f.usage, response_id: response,
    usage: { input_tokens: amount - 1000, cached_input_tokens: 100, output_tokens: 1000, reasoning_output_tokens: 100, cache_write_input_tokens: 35, total_tokens: amount } });
  const collect = () => task.recordUsage(f.call, options);
  return { ...f, runtime, admission, child, task, proof, options, usage, collect };
}
const ownedTest = (name, fn) => test(name, { skip: !["linux", "darwin"].includes(process.platform) }, fn);
ownedTest("owned real source accumulates 15k+7k once; cumulative/restored snapshots never charge", async t => {
  const f = await ownedFixture(t), a = f.usage(15000), b = f.usage(7000, "second");
  appendFileSync(f.file, verified(a));
  assert.equal(f.collect().totalTokens, 15000);
  appendFileSync(f.file, verified(b, 3));
  const total = f.collect(); assert.equal(total.totalTokens, 22000); assert.equal(total.cachedInputTokens, 200); assert.equal(total.cacheWriteInputTokens, 70);
  appendFileSync(f.file, verified({ ...a, thread_token_usage: { ...a.thread_token_usage, total_tokens: 99999999 } }, 5) + line("compacted", { message: "restored", latest_token_usage_record: a }, 7) + snapshot(a, 8));
  assert.deepEqual(f.collect(), total); assert.deepEqual(f.collect(), total);
  assert.equal(f.task.read(f.task.handle).usage.currentContext, null, "spending does not establish context");
});
ownedTest("opaque receipts reject clones, foreign task bindings and consumed receipt replay", async t => {
  const f = await ownedFixture(t), binding = {}, source = createOwnedUsageSource(f.call, { ...f.options, proof: f.proof }, binding);
  appendFileSync(f.file, verified(f.usage(15000)));
  const receipt = source(f.call, f.options);
  for (const bad of [{ ...receipt }, JSON.parse(JSON.stringify(receipt)), null])
    assert.throws(() => applyOwnedUsageReceipt(bad, binding, () => assert.fail()), /receipt/);
  assert.throws(() => applyOwnedUsageReceipt(receipt, {}, () => assert.fail()), /receipt/);
  let count; applyOwnedUsageReceipt(receipt, binding, rows => { count = rows.length; }); assert.equal(count, 1);
  assert.throws(() => applyOwnedUsageReceipt(receipt, binding, () => assert.fail()), /receipt/);
});
ownedTest("source and ledger failures are atomic, terminal, and never refresh consumption", async t => {
  for (const kind of ["changed", "gap", "ordinal", "truncated", "rollback", "overwrite", "root", "thread", "asset", "unknown", "overflow", "bytes", "lines", "capacity", "malformed"]) {
    await t.test(kind, async t => {
      const f = await ownedFixture(t); appendFileSync(f.file, verified(f.usage(15000))); f.collect();
      let rows = verified(f.usage(7000, "second"), 3);
      if (kind === "changed") rows = verified(f.usage(7000), 3);
      if (kind === "gap") rows = verified(f.usage(7000, "second"), 4);
      if (kind === "ordinal") rows += snapshot(f.usage(7000), 4);
      if (kind === "truncated") rows = rows.trimEnd();
      if (kind === "rollback") f.save("");
      if (kind === "overwrite") writeFileSync(f.file, readFileSync(f.file, "utf8").replace('"cached_input_tokens":100,', '"cached_input_tokens":101,'));
      if (kind === "root" || kind === "thread") rows = verified({ ...f.usage(7000, "second"), [kind === "root" ? "session_id" : "thread_id"]: "foreign" }, 3);
      if (kind === "asset") f.call.transcript_path = path.join(f.home, "sessions", "other.jsonl");
      if (kind === "unknown") rows += line("event_msg", { type: "unknown_usage" }, 5);
      if (kind === "overflow") rows = verified(f.usage(Number.MAX_SAFE_INTEGER, "second"), 3);
      if (kind === "bytes") rows = line("response_item", { type: "reasoning", text: "x".repeat(262144) }, 3);
      if (kind === "lines") rows = Array.from({ length: 1024 }, (_, i) => snapshot(f.usage(7000), i + 3)).join("");
      if (kind === "capacity") rows = Array.from({ length: 128 }, (_, i) => line("token_usage_record", f.usage(7000, `r${i}`), i + 3)).join("");
      if (kind === "malformed") rows += "bad json\n";
      if (kind !== "rollback") appendFileSync(f.file, rows);
      assert.throws(f.collect, /usage|Usage/);
      const saved = f.task.read(f.task.handle); assert.equal(saved.state, "terminal-rejected"); assert.equal(saved.usage.total.totalTokens, 15000);
      f.save(verified(f.usage(15000))); assert.throws(f.collect, /state/);
    });
  }
});
ownedTest("missing initial proof, foreign admission, unknown-only usage and completed tasks refuse", async t => {
  for (const kind of ["empty", "snapshot", "foreign", "completed", "missing", "nonfinite"]) await t.test(kind, async t => {
    const f = await ownedFixture(t);
    if (kind === "snapshot") appendFileSync(f.file, snapshot(f.usage(15000), 1));
    else if (kind !== "empty") appendFileSync(f.file, verified(f.usage(15000)));
    if (kind === "foreign") f.options.admission = {};
    if (kind === "nonfinite") f.save(verified({ ...f.usage(15000), usage: { ...tokens, total_tokens: 1e100 } }));
    if (kind === "completed") { f.collect(); const ended = once(f.child, "exit"); f.child.stdin.end(); await ended; await f.task.complete(() => {}); }
    if (kind === "missing") assert.throws(() => createOwnedUsageSource(f.call, { ...f.options, proof: {} }, {}), /usage|Usage/);
    else assert.throws(f.collect, /usage|Usage|state/);
  });
});
ownedTest("source mutation, replacement and missing response components refuse without partial ledger writes", async t => {
  for (const kind of ["mutation", "replacement", "invalid-utf8", "missing-usage", "rollback-event", "nan-component", "root-turn"]) await t.test(kind, async t => {
    const f = await ownedFixture(t); appendFileSync(f.file, verified(f.usage(15000))); f.collect();
    let rows = verified(f.usage(7000, "second"), 3);
    if (kind === "replacement") { const original = readFileSync(f.file); rmSync(f.file); writeFileSync(f.file, original); }
    if (kind === "invalid-utf8") rows = Buffer.concat([Buffer.from(rows), Buffer.from([255, 10])]);
    if (kind === "missing-usage") rows += line("token_usage_record", { ...f.usage(7000, "third"), usage: null }, 5);
    if (kind === "rollback-event") rows += line("event_msg", { type: "thread_rolled_back", num_turns: 1 }, 5);
    if (kind === "nan-component") rows += line("token_usage_record", { ...f.usage(7000, "third"), usage: { ...tokens, output_tokens: null } }, 5);
    if (kind === "root-turn") rows += line("token_usage_record", { ...f.usage(7000, "third"), root_turn_id: "foreign" }, 5);
    appendFileSync(f.file, rows);
    if (kind === "mutation") {
      const original = fs.readSync;
      t.mock.method(fs, "readSync", (...args) => { const count = original(...args); appendFileSync(f.file, "\n"); return count; });
      syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    }
    assert.throws(f.collect, /usage|Usage/); assert.equal(f.task.read(f.task.handle).usage.total.totalTokens, 15000);
  });
});
ownedTest("stale receipts cannot roll back a committed cursor; new tasks have independent ledgers", async t => {
  const f = await ownedFixture(t), binding = {}, source = createOwnedUsageSource(f.call, { ...f.options, proof: f.proof }, binding);
  appendFileSync(f.file, verified(f.usage(15000))); const old = source(f.call, f.options), current = source(f.call, f.options);
  applyOwnedUsageReceipt(current, binding, () => {});
  assert.throws(() => applyOwnedUsageReceipt(old, binding, () => assert.fail()), /usage|Usage/);
  assert.equal(f.collect().totalTokens, 15000);
  const other = await ownedFixture(t); appendFileSync(other.file, verified(other.usage(7000)));
  assert.equal(other.collect().totalTokens, 7000); assert.equal(f.collect().totalTokens, 15000);
});
ownedTest("pre-admission history is not a fresh baseline and dead native authority cannot append", async t => {
  const restored = await ownedFixture(t, verified(record()));
  assert.throws(restored.collect, /usage|Usage/); assert.equal(restored.task.read(restored.task.handle).usage.total, null);
  const f = await ownedFixture(t); appendFileSync(f.file, verified(f.usage(15000))); f.collect();
  const ended = once(f.child, "exit"); f.child.stdin.end(); await ended;
  assert.throws(f.collect, /state/); assert.equal(f.task.read(f.task.handle).usage.total.totalTokens, 15000);
});
ownedTest("native identity claims and unknown usage snapshots cannot be stripped into authority", async t => {
  for (const change of [{ role: "leader" }, { agent_id: "thread" }, { agent_type: "profile" }]) await t.test(JSON.stringify(change), async t => {
    const f = await ownedFixture(t); appendFileSync(f.file, verified(f.usage(15000))); Object.assign(f.call, change);
    assert.throws(f.collect, /usage|Usage/); assert.equal(f.task.read(f.task.handle).usage.total, null);
  });
  const f = await ownedFixture(t); appendFileSync(f.file, verified(f.usage(15000))); f.collect();
  appendFileSync(f.file, line("event_msg", { type: "token_count", info: null, rate_limits: null }, 3));
  assert.throws(f.collect, /usage|Usage/); assert.equal(f.task.read(f.task.handle).usage.total.totalTokens, 15000);
});
