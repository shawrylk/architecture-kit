import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCodexWorker } from "./codex-dispatch.mjs";

test("runner identity retains workflow role independently of native profile or agent id", () => {
  const input = { parentSessionId: "parent", workerSessionId: "worker", role: "implementer",
    worktree: process.cwd(), branch: "feat/example", brief: path.join(process.cwd(), "brief.md"), model: "gpt-5", report: "result.md" };
  const worker = normalizeCodexWorker(input);
  assert.equal(worker.session_id, "parent");
  assert.equal(worker.agent_id, "worker");
  assert.equal(worker.agent_type, "implementer");
  assert.equal(worker.cwd, input.worktree);
  assert.throws(() => normalizeCodexWorker({ ...input, role: "leader" }));
  assert.throws(() => normalizeCodexWorker({ ...input, workerSessionId: "" }));
  assert.throws(() => normalizeCodexWorker({ ...input, nativeProfile: "implementer", role: undefined }));
});

import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCodexDispatch } from "./codex-dispatch.mjs";
import { checkpointPathOf } from "./checkpoint.mjs";
import { readLedger } from "./ledger.mjs";
import { slotDirOf } from "./dispatch-slot.mjs";

function fixture(t, role = "implementer", dispatch = {}) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "qc-codex-dispatch-"))), root = path.join(base, "work");
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const git = (...args) => execFileSync("git", args, { cwd: base, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q", "-b", "main");
  git("-c", "user.name=qc", "-c", "user.email=qc@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "init", "--allow-empty");
  git("worktree", "add", "-qb", "feat/example", root);
  writeFileSync(path.join(root, "qc.config.json"), JSON.stringify({ swarm: { dispatch: { implementerSlots: 1, ...dispatch } } }));
  const checkpoint = checkpointPathOf(root, "parent");
  mkdirSync(path.dirname(checkpoint), { recursive: true });
  writeFileSync(checkpoint, "## Goal\n## Rules\n## Tasks\n## Next\n");
  const brief = path.join(root, "brief.md");
  writeFileSync(brief, "# Brief\n## Product decisions\nNone.\n");
  const input = { parentSessionId: "parent", workerSessionId: "worker", role, worktree: root,
    branch: "feat/example", brief, model: "gpt-6.1-sol", report: "" };
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null });
  const exit = (code = 0) => { child.exitCode = code; child.emit("exit", code, null); };
  child.kill = () => { exit(1); return true; };
  const proof = { pid: child.pid, worktree: root, workflowParentId: "parent", role: role === "implementer" ? role : "reviewer", nativeThreadId: "native" };
  const handle = {}, seen = [];
  const runtime = { reserve: options => { seen.push(options); return handle; }, ready: async () => proof,
    validate: (h, native) => h === handle && native.session_id === "native" ? proof : null,
    context: (h, native) => { assert.equal(h, handle); seen.push(native); return "worker-budget"; }, terminal: () => seen.push("retired") };
  const bridge = () => createCodexDispatch(input, { runtime, tmp: root, reads: { ci: () => null, base: () => true } });
  const slots = () => existsSync(slotDirOf("parent", root)) ? readdirSync(slotDirOf("parent", root)).filter(n => n.endsWith(".claim")).length : 0;
  const records = () => readLedger(path.join(base, ".git", "qc", "ledger.jsonl"));
  return { root, input, child, exit, proof, runtime, seen, bridge, slots, records, checkpoint, head: git("rev-parse", "HEAD") };
}
const native = { session_id: "native" };
const report = "RED: node --test fails\nGREEN: node --test passes";

test("admission precedes spawn; handback and exit together record one placed stop", async t => {
  const f = fixture(t), b = f.bridge();
  await b.start(() => { assert.equal(f.slots(), 1); return f.child; });
  assert.equal(await b.context(native), "worker-budget");
  assert.deepEqual(f.seen[0], { role: "implementer", workflowParentId: "parent" });
  assert.equal(f.seen[1], native);
  assert.throws(() => b.handback({ session_id: "sibling" }, report));
  assert.throws(() => b.handback(native, "done"), /RED/);
  b.handback(native, report);
  f.exit();
  assert.equal((await b.finish()).accepted, true);
  assert.deepEqual(await b.finish(), await b.finish());
  assert.equal(f.slots(), 0);
  const stops = f.records().filter(r => r.type === "stop");
  assert.equal(stops.length, 1);
  assert.equal(stops[0].worktree, f.root);
  assert.equal(stops[0].branch, f.input.branch);
  assert.equal(stops[0].agentId, "worker");
  assert.throws(() => b.handback(native, report));
  await assert.rejects(b.context(native));
  await assert.rejects(f.bridge().start(() => assert.fail("completed identity")), /completed/);
});

test("checkpoint, branch and occupied-slot refusals never spawn", async t => {
  const f = fixture(t);
  rmSync(f.checkpoint);
  await assert.rejects(f.bridge().start(() => assert.fail("spawn")), /Checkpoint/);
  writeFileSync(f.checkpoint, "## Goal\n## Rules\n## Tasks\n## Next\n");
  f.input.branch = "wrong";
  await assert.rejects(f.bridge().start(() => assert.fail("spawn")), /branch/i);
  f.input.branch = "feat/example";
  const first = f.bridge(); await first.start(() => f.child);
  f.input.workerSessionId = "second";
  await assert.rejects(f.bridge().start(() => assert.fail("spawn")), /slot/i);
  await first.cancel();
  assert.equal(f.slots(), 0);
});

for (const outcome of ["finish", "error", "cancel", "spawn-error", "startup-error", "identity-error", "nonzero"]) {
  test(`${outcome} cannot accept an exit without a validated handback and releases its slot`, async t => {
    const f = fixture(t), b = f.bridge();
    if (outcome === "spawn-error") await assert.rejects(b.start(() => { throw Error("spawn"); }));
    else {
      if (outcome === "startup-error") f.runtime.ready = async () => { throw Error("startup"); };
      if (outcome === "identity-error") f.proof.role = "leader";
      if (outcome.endsWith("-error")) await assert.rejects(b.start(() => f.child));
      else {
        await b.start(() => f.child);
        if (outcome === "nonzero") { b.handback(native, report); f.exit(1); }
        if (outcome === "finish") f.exit();
        assert.equal((await b[outcome === "nonzero" ? "finish" : outcome]()).accepted, false);
      }
    }
    assert.equal(f.slots(), 0);
    assert.equal(f.records().filter(r => r.type === "stop").length, 0);
  });
}

test("startup rejection retains the real slot until owned child termination is observed", async t => {
  const f = fixture(t), b = f.bridge();
  f.runtime.ready = async () => { throw Error("startup"); };
  f.child.kill = () => false;
  await assert.rejects(b.start(() => f.child), /termination/);
  assert.equal(f.slots(), 1);
  f.exit(1);
  await b.error();
  assert.equal(f.slots(), 0);
});

test("review verdicts and planner reports use the shared validation", async t => {
  for (const role of ["reviewer", "planner"]) {
    const f = fixture(t, role), b = f.bridge();
    await b.start(() => f.child);
    assert.throws(() => b.handback(native, "done"), role === "planner" ? /PLAN/ : /VERDICT/);
    if (role === "reviewer") {
      assert.throws(() => b.handback(native, "VERDICT: APPROVED deadbee\nRED-CHECKED: yes"), /commit/);
      b.handback(native, `VERDICT: APPROVED ${f.head}\nRED-CHECKED: observed failure`);
      f.exit(); assert.equal((await b.finish()).accepted, true);
      assert.equal(f.records().filter(r => r.type === "verdict").length, 1);
    } else {
      const file = path.join(f.root, "plan.md");
      writeFileSync(file, "# Plan\n### Task 1: One\n- Create: `a.mjs`\n**Estimate:** 20 tool calls\n- [ ] **Step 1: Write the failing test**\n- [ ] **Step 2: Commit**\n");
      b.handback(native, `PLAN: ${file}`); f.exit();
      assert.equal((await b.finish()).accepted, true);
      assert.equal(f.records().filter(r => r.role === "planner" && r.type === "stop").length, 1);
    }
  }
});

test("disabled shared guards retain opt-in behavior and native cost stays unknown", async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, "qc.config.json"), "{}");
  const b = f.bridge(), started = await b.start(() => f.child);
  assert.deepEqual(started.notes, []);
  assert.equal(f.slots(), 0);
  b.handback(native, "done"); f.exit();
  assert.equal((await b.finish()).accepted, true);
  assert.deepEqual(f.records(), []);
});

test("live finish, duplicate admission and spawn error cannot free another live worker", async t => {
  const f = fixture(t, "implementer", { implementerSlots: 2 }), b = f.bridge();
  await b.start(() => f.child);
  await assert.rejects(b.finish(), /exit/);
  await assert.rejects(f.bridge().start(() => assert.fail("duplicate spawn")), /identity/);
  assert.equal(f.slots(), 1);
  await b.cancel();
  f.input.workerSessionId = "new-worker";
  f.child.pid = undefined; f.child.exitCode = null;
  f.runtime.ready = async () => { f.child.emit("error", Error("spawn failed")); throw Error("startup"); };
  await assert.rejects(f.bridge().start(() => f.child), /startup/);
  assert.equal(f.slots(), 0);
});

test("terminal cleanup retry never duplicates a validated stop", async t => {
  const f = fixture(t), b = f.bridge(); await b.start(() => f.child);
  b.handback(native, report); f.exit();
  const folder = path.join(slotDirOf("parent", f.root), "slot-99.claim"); mkdirSync(folder);
  await assert.rejects(b.finish(), /EISDIR|EPERM|EACCES/);
  rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  assert.equal((await b.finish()).accepted, true);
  assert.equal(f.records().filter(r => r.type === "stop").length, 1);
  assert.equal(f.records().filter(r => r.type === "cost").length, 0);
});
