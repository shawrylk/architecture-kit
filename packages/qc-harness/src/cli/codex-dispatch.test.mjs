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
  const proof = { pid: child.pid, worktree: root, workflowParentId: "parent", role: ["implementer", "tests"].includes(role) ? "implementer" : "reviewer", nativeThreadId: "native" };
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

test("tests uses configured implementer admission/slot without implementer report semantics", async t => {
  const f = fixture(t, "tests", { implementerTypes: ["acceptance-writer"] }), b = f.bridge();
  await b.start(() => { assert.equal(f.slots(), 1); return f.child; });
  assert.deepEqual(f.seen[0], { role: "implementer", workflowParentId: "parent" });
  assert.equal(f.records().find(r => r.type === "dispatch").agentType, "acceptance-writer");
  assert.throws(() => b.handback(native, " "));
  f.proof.role = "reviewer";
  assert.throws(() => b.handback(native, "Tests prepared."));
  f.proof.role = "implementer";
  b.handback(native, "Tests prepared; pending implementation.");
  assert.equal(f.records().filter(r => r.type === "stop").length, 0);
  await assert.rejects(b.finish(), /exit/);
  assert.equal(f.records().filter(r => r.type === "stop").length, 0);
  f.exit();
  assert.equal((await b.finish()).accepted, true);
  assert.equal((await b.finish()).accepted, true);
  assert.equal(f.records().filter(r => r.type === "stop" && r.role === "tests").length, 1);
  assert.equal(f.records().filter(r => r.type === "verdict").length, 0);
  assert.equal(f.slots(), 0); assert.equal(f.seen.at(-1), "retired");
});

test("runner may establish its private bridge asynchronously before launching", async t => {
  const f = fixture(t), b = f.bridge();
  await b.start(async () => { await Promise.resolve(); return f.child; });
  b.handback(native, report); f.exit();
  assert.equal((await b.finish()).accepted, true);
  assert.equal(f.slots(), 0);
});

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

test("admitted lifecycle policy cannot be disabled before handback or finish", async t => {
  for (const role of ["implementer", "reviewer", "branch-reviewer", "planner"]) {
    for (const stage of ["handback", "finish"]) {
      const f = fixture(t, role), b = f.bridge();
      await b.start(() => f.child);
      if (stage === "finish") {
        const file = path.join(f.root, "plan.md");
        writeFileSync(file, "# Plan\n### Task 1: One\n- Create: `a.mjs`\n**Estimate:** 20 tool calls\n- [ ] **Step 1: Write the failing test**\n- [ ] **Step 2: Commit**\n");
        const message = role === "planner" ? `PLAN: ${file}` : role === "implementer" ? report :
          `VERDICT: APPROVED ${f.head}\nRED-CHECKED: observed failure`;
        b.handback(native, message);
      }
      writeFileSync(path.join(f.root, "qc.config.json"), "{}");
      if (stage === "handback") {
        assert.throws(() => b.handback(native, "done"), /policy.*changed/i);
        await b.cancel();
      } else {
        f.exit();
        const result = await b.finish();
        assert.equal(result.accepted, false);
        assert.match(result.notes.join("\n"), /policy.*changed/i);
      }
      assert.equal(f.slots(), 0);
      assert.equal(f.records().filter(r => ["stop", "verdict"].includes(r.type)).length, 0);
    }
  }
});

test("unreadable or invalid lifecycle policy fails closed without reflecting config contents", async t => {
  for (const mutation of ["missing", "directory", "invalid"]) {
    const f = fixture(t), b = f.bridge();
    await b.start(() => f.child);
    b.handback(native, report);
    const config = path.join(f.root, "qc.config.json");
    rmSync(config);
    if (mutation === "directory") mkdirSync(config);
    if (mutation === "invalid") writeFileSync(config, JSON.stringify({ swarm: { dispatch: {}, review: { maxTaskCalls: "private-config-value" } } }));
    assert.throws(() => b.handback(native, report), /^Error: Workflow policy changed during worker lifecycle$/);
    // A rejected replacement must also clear the earlier valid handback.
    rmSync(config, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    writeFileSync(config, JSON.stringify({ swarm: { dispatch: { implementerSlots: 1 } } }));
    f.exit();
    assert.equal((await b.finish()).accepted, false);
    assert.equal(f.slots(), 0);
    assert.equal(f.records().filter(r => r.type === "stop").length, 0);
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

test("scout uses planner admission with reviewer capability and its own handback/stop", async t => {
  const f = fixture(t, "scout"), b = f.bridge();
  await b.start(() => f.child);
  assert.deepEqual(f.seen[0], { role: "reviewer", workflowParentId: "parent" });
  assert.equal(f.records().find(r => r.type === "dispatch").agentType, "sdd-planner");
  assert.equal(f.slots(), 0);
  assert.throws(() => b.handback(native, report), /Gap/);
  assert.throws(() => b.handback(native, `VERDICT: APPROVED ${f.head}`), /Gap/);
  f.proof.role = "implementer";
  assert.throws(() => b.handback(native, "Gap: gap"));
  f.proof.role = "reviewer";
  b.handback(native, "Gap: gap\nPlan: plan\nCheck: checked\nRisks: none\nQuestions: none\nBreaking: no");
  assert.equal(f.records().filter(r => r.type === "stop").length, 0);
  f.exit();
  assert.equal((await b.finish()).accepted, true);
  assert.equal((await b.finish()).accepted, true);
  assert.equal(f.records().filter(r => r.type === "stop" && r.role === "scout").length, 1);
  assert.equal(f.records().filter(r => r.type === "verdict").length, 0);
  assert.equal(f.seen.at(-1), "retired");
});
