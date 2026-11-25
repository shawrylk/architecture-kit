import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, symlinkSync, readFileSync, renameSync } from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { once, EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createCodexRuntime } from "./codex-runtime.mjs";

function fixture(t, options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-runtime-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  mkdirSync(path.join(dir, ".git"));
  const bin = path.join(dir, "native");
  writeFileSync(bin, `#!/bin/sh\nread -r thread\nprintf '{"type":"thread.started","thread_id":"%s"}\\n' "$thread"\nprintf "%s\\n" "$@"\nprintf "QC_FIXTURE_DONE\\n"\ncat >/dev/null\n`, { mode: 0o700 });
  const runtime = createCodexRuntime({ worktree: dir, executable: bin, workflowId: "workflow", ...options });
  const reserve = (role = "leader", extra = {}) => runtime.reserve({ role, workflowParentId: "parent", ...extra });
  const hook = { hook_event_name: "SessionStart", source: "startup", cwd: dir, session_id: "native-thread" };
  return { dir, runtime, reserve, hook };
}
async function start(t, f, reservation, session = "native-thread") {
  const child = f.runtime.launch(reservation);
  t.after(() => { child.stdin.end(); child.kill(); });
  child.output = new Promise((resolve, reject) => {
    let output = "";
    const cleanup = () => { child.stdout.off("data", collect); child.stdout.off("end", incomplete); };
    const incomplete = () => { cleanup(); reject(new Error("Incomplete fixture output")); };
    const collect = data => {
      output += data.toString();
      const end = output.indexOf("\nQC_FIXTURE_DONE\n");
      if (end < 0) return;
      cleanup(); resolve(output.slice(0, end + 1));
    };
    child.stdout.on("data", collect); child.stdout.once("end", incomplete);
  });
  await once(child, "spawn");
  child.stdin.write(session + "\n");
  await child.output;
  return child;
}
test("startup fixture collects fragmented output through its completion delimiter", async t => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
  child.stdin.once("data", () => {
    child.stdout.write('{"type":"thread.started","thread_id":"native-thread"}\n');
    setImmediate(() => {
      child.stdout.write("exec\nmodel_auto_compact_token_limit=400000\nQC_FIX");
      setImmediate(() => child.stdout.write("TURE_DONE\n"));
    });
  });
  const f = { runtime: { launch() { process.nextTick(() => child.emit("spawn")); return child; } } };
  const started = await start(t, f, {});
  assert.equal(await started.output,
    '{"type":"thread.started","thread_id":"native-thread"}\nexec\nmodel_auto_compact_token_limit=400000\n');
});
const supported = ["linux", "darwin"].includes(process.platform);
test("controlled argv proves explicit 400000 and disabled percentage only after authenticated SessionStart", { skip: !supported }, async t => {
  const f = fixture(t), r = f.reserve(), child = await start(t, f, r);
  assert.equal(f.runtime.validate(r, f.hook), null);
  assert.throws(() => f.runtime.bind(r, {}, f.hook), /unavailable/);
  assert.throws(() => f.runtime.bind(r, r.hookCredential, { ...f.hook, session_id: "forged-thread" }), /unavailable/);
  const proof = f.runtime.bind(r, r.hookCredential, f.hook);
  assert.deepEqual(f.runtime.bind(r, r.hookCredential, f.hook), proof);
  assert.equal(proof.role, "leader");
  assert.ok(proof.budget.compactAt > 0);
  assert.equal(proof.settingsProvenance, "controlled-cli-forwarding");
  assert.equal(proof.nativeRootSessionId, null);
  assert.equal(proof.nativeThreadId, "native-thread");
  assert.equal(proof.settings.model_auto_compact_token_limit, 400000);
  assert.equal(proof.settings.model_post_turn_compact_threshold_percent, 0);
  const output = await child.output;
  assert.match(output, /model_auto_compact_token_limit=400000/);
  assert.match(output, /model_post_turn_compact_threshold_percent=0/);
  assert.equal(JSON.stringify(r), "{}");
  assert.deepEqual(output.trim().split("\n").slice(1), ["exec", "-C", f.dir, "--json", "-c",
    "model_auto_compact_token_limit=400000", "-c", "model_post_turn_compact_threshold_percent=0", "-"]);
});
test("repository, role, parent, native session and provenance cannot be substituted", { skip: !supported }, async t => {
  const f = fixture(t), other = fixture(t), r = f.reserve();
  await start(t, f, r);
  assert.throws(() => other.runtime.launch(r), /unavailable/);
  assert.throws(() => f.runtime.bind({ ...r }, r.hookCredential, f.hook), /unavailable/);
  for (const extra of [{ cwd: other.dir }, { agent_id: "x" }, { role: "reviewer" }, { hook_event_name: "PreToolUse" }, { source: "resume" }, { source: "compact" }, { source: undefined }])
    assert.throws(() => f.runtime.bind(r, r.hookCredential, { ...f.hook, ...extra }), /unavailable/);
  f.runtime.bind(r, r.hookCredential, f.hook);
  assert.equal(f.runtime.validate(r, { ...f.hook, session_id: "other" }), null);
  assert.throws(() => f.runtime.bind(r, r.hookCredential, { ...f.hook, session_id: "other" }), /unavailable/);
  assert.throws(() => f.reserve("leader", { parent: {} }), /unavailable/);
  assert.throws(() => f.reserve("admin"), /unavailable/);
});
test("worker restriction and admitted scalar budget survive edits and terminal retirement", { skip: !supported }, async t => {
  const policy = { budgets: { implementer: { remindAt: 10, handoffAt: 20 } } };
  const f = fixture(t, { config: policy }), r = f.reserve("implementer");
  policy.budgets.implementer.handoffAt = 200;
  await start(t, f, r);
  const proof = f.runtime.bind(r, r.hookCredential, f.hook);
  assert.equal(proof.settings, null);
  const restricted = fixture(t, { inheritedRole: "implementer" });
  assert.throws(() => restricted.reserve("leader"), /unavailable/);
  assert.throws(() => restricted.reserve("reviewer"), /unavailable/);
  assert.deepEqual(proof.budget, { remindAt: 10, handoffAt: 20 });
  writeFileSync(path.join(f.dir, "qc.config.json"), '{"budgets":{"implementer":null}}');
  assert.deepEqual(f.runtime.validate(r, f.hook).budget, proof.budget);
  assert.throws(() => f.reserve("leader", { parent: r }), /unavailable/);
  assert.throws(() => f.reserve("reviewer", { parent: r }), /unavailable/);
  const closure = path.join(f.dir, "qc-role-budgets", "closed.json");
  mkdirSync(path.dirname(closure));
  const closed = '{"policy":{"budgetClosed":true},"budget":{"remindAt":10,"handoffAt":20}}';
  writeFileSync(closure, closed, { mode: 0o600 });
  f.runtime.terminal(r);
  assert.equal(readFileSync(closure, "utf8"), closed);
  assert.equal(f.runtime.validate(r, f.hook), null);
  assert.throws(() => f.runtime.bind(r, r.hookCredential, f.hook), /unavailable/);
  assert.throws(() => f.runtime.launch(r), /unavailable/);

});
test("bounded concurrent reservations isolate native threads and retire on failure or exit", { skip: !supported }, async t => {
  const f = fixture(t, { capacity: 4 }), reservations = Array.from({ length: 4 }, () => f.reserve());
  assert.throws(() => f.reserve(), /unavailable/);
  const children = await Promise.all(reservations.map((r, i) => start(t, f, r, `native-${i}`)));
  const proofs = reservations.map((r, i) => f.runtime.bind(r, r.hookCredential, { ...f.hook, session_id: `native-${i}` }));
  assert.equal(new Set(proofs.map(p => p.incarnation)).size, 4);
  assert.throws(() => f.runtime.launch(reservations[0]), /unavailable/);
  children[0].stdin.end(); await once(children[0], "close");
  assert.equal(f.runtime.validate(reservations[0], { ...f.hook, session_id: "native-0" }), null);
  const fresh = f.reserve();
  await start(t, f, fresh, "native-0");
  assert.throws(() => f.runtime.bind(fresh, fresh.hookCredential, { ...f.hook, session_id: "native-0" }), /unavailable/);
  assert.throws(() => f.runtime.bind(fresh, reservations[0].hookCredential, f.hook), /unavailable/);
  const bad = fixture(t, { executable: path.join(f.dir, "absent") }), pending = bad.reserve();
  const child = bad.runtime.launch(pending); await once(child, "error");
  assert.throws(() => bad.runtime.launch(pending), /unavailable/);
});
test("bounded contract refuses arbitrary flags, weak policy, unsupported platforms and non-repositories", t => {
  if (!supported) { assert.throws(() => createCodexRuntime({}), /unsupported platform/); return; }
  const f = fixture(t);
  for (const extra of [{ args: ["-c", "model_auto_compact_token_limit=1"] }, { args: ["--config=model_post_turn_compact_threshold_percent=90"] }, { profile: "leader" }])
    assert.throws(() => f.reserve("leader", extra), /unavailable/);
  assert.throws(() => f.reserve("leader", { workflowParentId: "x".repeat(129) }), /unavailable/);
  assert.throws(() => fixture(t, { config: { budgets: { implementer: { remindAt: 20, handoffAt: 10 } } } }));
  assert.throws(() => fixture(t, { capacity: 257 }), /unavailable/);
  assert.throws(() => createCodexRuntime({ worktree: os.tmpdir(), executable: f.dir, workflowId: "x" }), /unavailable/);
  assert.equal(statSync(path.join(f.dir, "native")).mode & 0o077, 0);
});
test("bound workflow parent and external native top-level identities remain distinct", { skip: !supported }, async t => {
  const f = fixture(t), parent = f.reserve(); await start(t, f, parent);
  f.runtime.bind(parent, parent.hookCredential, f.hook);
  const worker = f.reserve("reviewer", { parent }); await start(t, f, worker, "external-worker");
  const proof = f.runtime.bind(worker, worker.hookCredential, { ...f.hook, session_id: "external-worker" });
  assert.equal(proof.parentNativeRootSessionId, null);
  assert.equal(proof.parentNativeThreadId, "native-thread");
  assert.equal(proof.nativeRootSessionId, null);
  assert.equal(proof.nativeThreadId, "external-worker");
  assert.equal(proof.workflowParentId, "parent");
  assert.equal(proof.workflowId, "workflow");
  assert.throws(() => { proof.role = "leader"; }, TypeError);
  assert.throws(() => { proof.budget.handoffAt = 1; }, TypeError);
});
test("canonical linked checkout identity is bounded and separate from the common repository", { skip: !supported }, async t => {
  const f = fixture(t), linked = path.join(f.dir, "linked"), gitdir = path.join(f.dir, ".git", "worktrees", "linked");
  mkdirSync(linked); mkdirSync(gitdir, { recursive: true });
  writeFileSync(path.join(linked, ".git"), `gitdir: ${gitdir}\n`);
  writeFileSync(path.join(gitdir, "commondir"), "../..\n");
  const alias = path.join(f.dir, "alias"); symlinkSync(linked, alias);
  const runtime = createCodexRuntime({ worktree: alias, executable: path.join(f.dir, "native"), workflowId: "other-workflow" });
  const r = runtime.reserve({ role: "leader", workflowParentId: "parent" });
  await start(t, { runtime }, r);
  const proof = runtime.bind(r, r.hookCredential, { ...f.hook, cwd: alias });
  assert.equal(proof.worktree, linked);
  assert.equal(proof.repository, path.join(f.dir, ".git"));
  assert.equal(runtime.validate(r, f.hook), null);
  writeFileSync(path.join(linked, ".git"), "x".repeat(8192));
  assert.equal(runtime.validate(r, { ...f.hook, cwd: linked }), null);
  assert.throws(() => createCodexRuntime({ worktree: linked, executable: path.join(f.dir, "native"), workflowId: "x" }), /unavailable/);
});
test("first native event is bounded independently of coalesced later output", { skip: !supported }, async t => {
  const first = '{"type":"thread.started","thread_id":"native-thread"}';
  const later = JSON.stringify({ type: "item.completed", payload: "x".repeat(9000) }) + "\n";
  const exact = first + " ".repeat(8192 - Buffer.byteLength(first));
  const byteOversized = first.slice(0, -1) + ',"payload":"' + "é".repeat(4096) + '"}';
  for (const [chunks, valid] of [
    [[first + "\n" + later], true],
    [[first.slice(0, 17), first.slice(17) + "\n" + later], true],
    [[exact, "\n" + later], true],
    [[exact + " \n" + later], false],
    [[byteOversized], false],
  ]) {
    const f = fixture(t, { capacity: 1 }), r = f.reserve();
    const child = f.runtime.launch(r);
    t.after(() => { child.stdin.end(); child.kill(); });
    await once(child, "spawn");
    // Inject exact stream chunk boundaries while the fixture waits on stdin.
    for (const chunk of chunks) child.stdout.emit("data", chunk);
    if (valid) {
      assert.equal(f.runtime.bind(r, r.hookCredential, f.hook).nativeThreadId, "native-thread");
      assert.throws(() => f.reserve(), /unavailable/);
    } else {
      assert.throws(() => f.runtime.bind(r, r.hookCredential, f.hook), /unavailable/);
      f.reserve();
    }
  }
});
test("missing, malformed and oversized native identity streams stay unknown and release slots", { skip: !supported }, async t => {
  for (const line of ["not-json", '{"type":"thread.started"}', "x".repeat(8193)]) {
    const f = fixture(t, { capacity: 1 });
    writeFileSync(path.join(f.dir, "native"), `#!/bin/sh\nprintf '%s\\n' '${line}'\nprintf 'QC_FIXTURE_DONE\\n'\ncat >/dev/null\n`, { mode: 0o700 });
    const r = f.reserve(); await start(t, f, r);
    assert.equal(f.runtime.validate(r, f.hook), null);
    assert.throws(() => f.runtime.bind(r, r.hookCredential, f.hook), /unavailable/);
    f.reserve();
  }
  const f = fixture(t, { capacity: 1 }), r = f.reserve();
  assert.throws(() => f.runtime.bind(r, r.hookCredential, f.hook), /unavailable/);
  f.runtime.terminal(r);
  for (let i = 1; i < 256; i++) f.runtime.terminal(f.reserve());
  assert.throws(() => f.reserve(), /unavailable/);
  const bad = fixture(t, { executable: "/invalid\0", capacity: 1 }), pending = bad.reserve();
  assert.throws(() => bad.runtime.launch(pending), /unavailable/);
  bad.reserve();
});

for (const early of [true, false]) test(`startup correlation handles hook first=${early} without holding its acknowledgement`, { skip: !supported }, async t => {
  const f = fixture(t), r = f.reserve(), ready = f.runtime.ready(r);
  if (early) assert.equal(f.runtime.startup(r, r.hookCredential, f.hook), true);
  const child = f.runtime.launch(r);
  t.after(() => { child.stdin.end(); child.kill(); });
  await once(child, "spawn");
  child.stdin.write("native-thread\n");
  if (!early) { await once(child.stdout, "data"); f.runtime.startup(r, r.hookCredential, f.hook); }
  const proof = await ready;
  assert.equal(proof.nativeThreadId, "native-thread");
  assert.equal(f.runtime.startup(r, r.hookCredential, f.hook), true);
  assert.strictEqual(await f.runtime.ready(r), proof);
  for (const source of ["compact", "resume"]) assert.throws(() => f.runtime.startup(r, r.hookCredential, { ...f.hook, source }), /unavailable/);
  assert.equal(child.stdout.listenerCount("data"), 0);
});
test("deferred local header establishes a distinct root once, with immutable admission and selected provenance", { skip: !supported }, async t => {
  const home = mkdtempSync(path.join(os.tmpdir(), "qc-runtime-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const f = fixture(t, { codexHome: home }), r = f.reserve(); await start(t, f, r);
  mkdirSync(path.join(home, "sessions"));
  const transcript = path.join(home, "sessions", "selected.jsonl"), hook = { ...f.hook, transcript_path: transcript };
  assert.throws(() => f.runtime.bind(r, r.hookCredential, { ...hook, transcript_path: "relative.jsonl" }), /unavailable/);
  assert.equal(f.runtime.validate(r, f.hook), null);
  const admitted = f.runtime.bind(r, r.hookCredential, { ...hook, nativeRootSessionId: "forged", nativeConfig: { model_auto_compact_token_limit: 1 } });
  assert.equal(admitted.nativeRootSessionId, null);
  const timestamp = new Date().toISOString();
  const header = (extra = {}) => JSON.stringify({ type: "session_meta", ordinal: 0, timestamp,
    payload: { id: "native-thread", session_id: "native-root", cli_version: "0.172.0", cwd: f.dir, source: "exec", ...extra } }) + "\n";
  for (const bad of [{ id: "wrong-thread" }, { cwd: os.tmpdir() }, { source: { subagent: { thread_spawn: { parent_thread_id: "parent", agent_role: "implementer", depth: 1 } } } }]) {
    writeFileSync(transcript, header(bad)); assert.equal(f.runtime.validate(r, hook).nativeRootSessionId, null);
  }
  writeFileSync(transcript, header());
  const known = f.runtime.validate(r, hook);
  assert.equal(known.nativeRootSessionId, "native-root");
  assert.equal(known.identityProvenance.provenance, "codex-0.172.0/session_meta/local-file");
  for (const field of ["role", "budget", "incarnation", "settings"]) assert.strictEqual(known[field], admitted[field]);
  assert.equal(known.nativeConfig, undefined);
  assert.throws(() => f.runtime.bind(r, r.hookCredential, { ...hook, transcript_path: transcript + "other" }), /unavailable/);
  assert.equal(f.runtime.validate(r, { ...hook, transcript_path: transcript + "other" }), null);
  writeFileSync(transcript, header({ session_id: "replacement-root" }));
  assert.equal(f.runtime.validate(r, hook), null);
  assert.throws(() => f.runtime.bind(r, r.hookCredential, hook), /unavailable/);
  writeFileSync(transcript, header()); assert.equal(f.runtime.validate(r, hook).nativeRootSessionId, "native-root");
  const replacement = transcript + ".new"; writeFileSync(replacement, header()); renameSync(replacement, transcript);
  assert.equal(f.runtime.validate(r, hook), null);
});
test("pending startup envelopes are bounded, authenticated and isolated", { skip: !supported }, async t => {
  const f = fixture(t, { capacity: 2 }), a = f.reserve(), b = f.reserve();
  const children = [a, b].map(r => f.runtime.launch(r));
  t.after(() => children.forEach(c => { c.stdin.end(); c.kill(); }));
  assert.throws(() => f.runtime.startup(a, b.hookCredential, f.hook), /unavailable/);
  for (const extra of [{ cwd: os.tmpdir() }, { session_id: "bad!" }, { payload: "é".repeat(4096) },
    { settings: {} }, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`key${i}`, "x"]))])
    assert.throws(() => f.runtime.startup(a, a.hookCredential, { ...f.hook, ...extra }), /unavailable/);
  f.runtime.startup(a, a.hookCredential, f.hook);
  f.runtime.startup(b, b.hookCredential, { ...f.hook, session_id: "second" });
  assert.throws(() => f.runtime.startup(a, a.hookCredential, { ...f.hook, session_id: "second" }), /unavailable/);
  await Promise.all(children.map(c => once(c, "spawn")));
  const ready = [f.runtime.ready(a), f.runtime.ready(b)];
  children[1].stdin.write("second\n"); children[0].stdin.write("native-thread\n");
  assert.deepEqual((await Promise.all(ready)).map(p => p.nativeThreadId), ["native-thread", "second"]);
  f.runtime.terminal(a);
  const replay = f.reserve(); await start(t, f, replay);
  const rejected = assert.rejects(f.runtime.ready(replay), /unavailable/);
  f.runtime.startup(replay, replay.hookCredential, f.hook); await rejected;
  assert.equal(f.runtime.validate(replay, f.hook), null);
});
test("startup deadlines and cancellation/error/exit remove listeners and release capacity", { skip: !supported }, async t => {
  for (const mode of ["timeout", "cancel", "error", "exit", "malformed", "mismatch"]) {
    const f = fixture(t, { capacity: 1, startupTimeoutMs: 200 }), r = f.reserve(), child = f.runtime.launch(r);
    t.after(() => { child.stdin.end(); child.kill(); });
    const failed = assert.rejects(f.runtime.ready(r), /unavailable/);
    f.runtime.startup(r, r.hookCredential, f.hook);
    await once(child, "spawn");
    if (mode === "cancel") f.runtime.terminal(r);
    if (mode === "error") child.emit("error", new Error("fixture failure"));
    if (mode === "exit") child.stdin.end();
    if (mode === "malformed") child.stdout.emit("data", "not-json\n");
    if (mode === "mismatch") child.stdin.write("other-thread\n");
    await failed;
    for (const [emitter, event] of [[child.stdout, "data"], [child, "spawn"], [child, "exit"], [child, "error"]])
      assert.equal(emitter.listenerCount(event), 0, `${mode}: ${event}`);
    assert.equal(f.runtime.validate(r, f.hook), null); f.runtime.terminal(f.reserve());
  }
  for (const startupTimeoutMs of [0, 30001, NaN]) assert.throws(() => fixture(t, { startupTimeoutMs }), /unavailable/);
});

test("trusted runner pin binds real executable digest/version and detects prelaunch drift", { skip: !supported }, async t => {
  for (const drift of [false, "bytes", "path", "replacement"]) {
    const f = fixture(t), executable = path.join(f.dir, "native");
    const pin = { realpath: executable, version: "0.172.0", sha256: createHash("sha256").update(readFileSync(executable)).digest("hex") };
    const runtime = createCodexRuntime({ worktree: f.dir, executable, workflowId: "pinned", executablePin: pin });
    pin.version = "forged";
    const r = runtime.reserve({ role: "leader", workflowParentId: "parent" });
    if (drift === "replacement") { writeFileSync(executable + ".new", readFileSync(executable), { mode: 0o700 }); renameSync(executable + ".new", executable); }
    if (drift === "bytes") writeFileSync(executable, "#!/bin/sh\nexit 1\n");
    if (drift === "path") { rmSync(executable); symlinkSync(process.execPath, executable); }
    if (drift) { assert.throws(() => { const child = runtime.launch(r); t.after(() => child.kill()); }, /unavailable/); assert.throws(() => runtime.ready(r), /unavailable/); }
    else {
      await start(t, { runtime }, r);
      assert.equal(runtime.bind(r, r.hookCredential, f.hook).executablePin.version, "0.172.0");
    }
    assert.throws(() => createCodexRuntime({ worktree: f.dir, executable, workflowId: "bad", executablePin: { ...pin, version: "0.171.0" } }), /unavailable/);
  }
});

test("unlaunched reservations expire and cancellation before spawn drains process listeners", { skip: !supported }, async t => {
  const f = fixture(t, { capacity: 1, startupTimeoutMs: 20 }), r = f.reserve();
  const expired = assert.rejects(f.runtime.ready(r), /unavailable/);
  await new Promise(resolve => setTimeout(resolve, 40)); await expired;
  assert.throws(() => f.runtime.launch(r), /unavailable/);
  for (const executable of [path.join(f.dir, "native"), path.join(f.dir, "missing")]) {
    const g = fixture(t, { executable }), pending = g.reserve(), child = g.runtime.launch(pending);
    const cancelled = assert.rejects(g.runtime.ready(pending), /unavailable/);
    g.runtime.terminal(pending); child.stdin.end();
    await new Promise(resolve => child.once("close", resolve)); await cancelled;
    for (const event of ["error", "spawn", "exit"]) assert.equal(child.listenerCount(event), 0);
  }
});
