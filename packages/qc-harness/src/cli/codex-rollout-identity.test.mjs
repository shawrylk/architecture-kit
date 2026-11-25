import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { readCodexRolloutIdentity } from "./codex-rollout-identity.mjs";

const now = Date.parse("2026-11-26T10:00:00Z"), HEAD = 65536;
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qc-native-identity-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  fs.mkdirSync(path.join(home, "sessions"));
  const file = path.join(home, "sessions", "rollout.jsonl");
  const meta = { id: "thread", session_id: "root", cwd: home, cli_version: "0.172.0", source: "exec" };
  const row = { timestamp: new Date(now - 1000000).toISOString(), ordinal: 0, type: "session_meta", payload: meta };
  const save = (value = row) => fs.writeFileSync(file, JSON.stringify(value) + "\n");
  const input = { transcriptPath: file, checkout: home, threadId: "thread" };
  const read = (change = {}, options = {}) => readCodexRolloutIdentity({ ...input, ...change }, { codexHome: home, now, ...options });
  save(); return { home, file, meta, row, save, read };
}
function patch(t, name, fn) {
  const original = fs[name]; t.mock.method(fs, name, (...args) => fn(original, ...args)); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test("header-only observation separates native root/thread without role or settings authority", (t) => {
  const f = fixture(t), result = f.read();
  assert.equal(result.nativeRootSessionId, "root"); assert.equal(result.nativeThreadId, "thread");
  assert.equal(result.source, "exec"); assert.equal(result.provenance, "codex-0.172.0/session_meta/local-file");
  assert.match(result.fileIdentity.file, /^[a-f0-9]{64}$/); assert.equal(result.fileIdentity.bytes, fs.statSync(f.file).size);
  assert.equal(result.fileIdentity.ordinal, 0); assert.equal(result.fileIdentity.timestamp, now - 1000000);
  assert.doesNotMatch(JSON.stringify(result), /rollout\.jsonl|role|settings|workflow/);
  for (const source of ["cli", "vscode", { subagent: { thread_spawn: { parent_thread_id: "parent", depth: 1, agent_role: "profile" } } }]) {
    f.meta.source = source; f.meta.session_id = "thread"; f.save();
    assert.equal(f.read().source, typeof source === "string" ? source : "thread_spawn");
  }
});

test("missing or deferred headers, foreign paths and wrong checkout/thread remain unknown", (t) => {
  assert.equal(readCodexRolloutIdentity(), null); assert.equal(readCodexRolloutIdentity(null), null);
  const f = fixture(t); fs.rmSync(f.file); assert.equal(f.read(), null);
  fs.writeFileSync(f.file, ""); assert.equal(f.read(), null); f.save(); assert.ok(f.read());
  for (const change of [{ threadId: "other" }, { checkout: os.tmpdir() }, { transcriptPath: "relative.jsonl" }, { threadId: null }]) assert.equal(f.read(change), null);
  const foreign = path.join(f.home, "outside.jsonl"); fs.copyFileSync(f.file, foreign);
  assert.equal(f.read({ transcriptPath: foreign }), null);
  const directory = path.join(f.home, "sessions", "directory.jsonl"); fs.mkdirSync(directory);
  assert.equal(f.read({ transcriptPath: directory }), null);
  if (process.platform !== "win32") {
    const alias = path.join(f.home, "sessions", "alias.jsonl"); fs.symlinkSync(f.file, alias);
    assert.equal(f.read({ transcriptPath: alias }), null);
  }
});

test("unsupported versions, sources, forks and malformed header metadata stay unknown", (t) => {
  const f = fixture(t);
  for (const change of [{ cli_version: "0.171.0" }, { source: "remote" }, { source: {} }, { session_id: "bad/id" },
    { forked_from_id: "parent" }, { history_base: {} }, { source: { subagent: { thread_spawn: { parent_thread_id: "parent", depth: 0, agent_role: "profile" } } } }]) {
    f.save({ ...f.row, payload: { ...f.meta, ...change } }); assert.equal(f.read(), null, JSON.stringify(change));
  }
  for (const change of [{ timestamp: null }, { timestamp: "bad" }, { timestamp: new Date(now + 1).toISOString() },
    { ordinal: undefined }, { ordinal: -1 }, { ordinal: 0.5 }, { type: "turn_context" }, { payload: null }]) {
    f.save({ ...f.row, ...change }); assert.equal(f.read(), null, JSON.stringify(change));
  }
  for (const raw of ["{broken}\n", JSON.stringify(f.row), Buffer.from([0xff, 10])]) {
    fs.writeFileSync(f.file, raw); assert.equal(f.read(), null);
  }
  f.row.padding = "é"; const invalidUtf8 = Buffer.from(JSON.stringify(f.row) + "\n");
  invalidUtf8[invalidUtf8.indexOf(Buffer.from("é"))] = 0xff;
  fs.writeFileSync(f.file, invalidUtf8); assert.equal(f.read(), null);
});

test("identity reads exactly one bounded head, with a byte-exact header limit", (t) => {
  const f = fixture(t), reads = [];
  patch(t, "readSync", (original, fd, buffer, offset, length, start) => {
    reads.push([start, length]); return original(fd, buffer, offset, length, start);
  });
  f.row.padding = "é"; const base = Buffer.byteLength(JSON.stringify(f.row) + "\n");
  f.row.padding += "x".repeat(HEAD - base); f.save();
  fs.appendFileSync(f.file, Buffer.alloc(400000, 0xff));
  assert.ok(f.read()); assert.deepEqual(reads.splice(0), [[0, HEAD]]);
  f.row.padding += "x"; f.save(); assert.equal(f.read(), null); assert.deepEqual(reads.splice(0), [[0, HEAD]]);
  delete f.row.padding; f.save(); const size = fs.statSync(f.file).size;
  assert.ok(f.read()); assert.deepEqual(reads, [[0, size]]);
});

test("short reads, read failures and descriptor mutations fail closed", async (t) => {
  for (const kind of ["short", "error", "append", "rewrite", "replace"]) await t.test(kind, (t) => {
    const f = fixture(t);
    patch(t, "readSync", (original, ...args) => {
      if (kind === "error") throw new Error("read failed");
      const count = original(...args);
      if (kind === "append") fs.appendFileSync(f.file, "\n");
      if (kind === "rewrite") { f.meta.session_id = "evil"; f.save(); }
      if (kind === "replace") { fs.renameSync(f.file, f.file + ".old"); f.save(); }
      return kind === "short" ? count - 1 : count;
    });
    assert.equal(f.read(), null);
  });
});
