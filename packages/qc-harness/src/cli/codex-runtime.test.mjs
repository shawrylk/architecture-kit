import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, symlinkSync, readFileSync } from "node:fs";
import os from "node:os";
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
