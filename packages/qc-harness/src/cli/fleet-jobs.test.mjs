import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { jobsHeartbeat, jobsTick, recoverJobs, runJobLoop } from "./fleet-jobs.mjs";
import { readState, writeState } from "./fleet-state.mjs";

const now = 100_000, head = "a".repeat(40);
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-jobs-"));
  mkdirSync(path.join(root, ".git"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const fleet = { self: "worker", secret: "ab".repeat(32), nodes: ["leader", "worker", "other"].map((id, i) => ({ id, address: "localhost", port: 8000 + i })) };
  writeState(root, "node", { jobs: { max: 2 } });
  writeState(root, "peers", { leader: { leader: true, term: 1, time: now } });
  const sent = [], calls = [];
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const deps = { root, fleet, repo: "o/r", clock: () => now, warn: () => {},
    fetch: async (_url, opts) => { sent.push(JSON.parse(opts.body)); return { status: 202 }; },
    git: async (cwd, ...args) => { calls.push([cwd, ...args]); return { stdout: args[0] === "rev-parse" ? head : "" }; },
    loop: async (_cwd, _args, { signal }) => { calls.push(["loop", _args]); return Promise.race([pending, new Promise(resolve => signal.addEventListener("abort", () => resolve({ code: 1 }), { once: true }))]); } };
  const body = { id: "job-1", branch: "feat/job", base: "main", brief: "Worktree: `old`\nReport: `old`\nProgress: `old`\n", rounds: 3 };
  const queue = (changes = {}, kind = "codex-job", from = "leader") => writeState(root, "queue", [...readState(root, "queue"), { id: String(Math.random()), repo: "o/r", kind, from, body: { ...body, ...changes } }]);
  const settle = async () => { for (let n = 0; n < 12; n++) await new Promise(resolve => setImmediate(resolve)); };
  return { root, fleet, sent, calls, deps, queue, body, release, settle };
}
for (const [label, changes] of Object.entries({ id: { id: "../bad" }, branch: { branch: "--bad" }, base: { base: "bad ref" }, brief: { brief: 42 }, bytes: { brief: "é".repeat(33000) }, rounds: { rounds: 7 }, fraction: { rounds: 1.5 }, extra: { command: "touch bad" } })) {
  test(`worker refuses invalid ${label} before git`, async t => {
    const f = fixture(t); f.queue(changes); await jobsTick(f.deps);
    assert.equal(f.sent.at(-1).body.state, "refused"); assert.equal(f.calls.length, 0);
    assert.equal(readState(f.root, "queue").length, 0);
  });
}
for (const rule of ["disabled", "full", "limited", "known", "local", "origin", "wrong-leader"]) {
  test(`worker refuses ${rule}`, async t => {
    const f = fixture(t);
    if (rule === "disabled") writeState(f.root, "node", {});
    if (rule === "full") writeState(f.root, "node", { jobs: { max: 0 } });
    if (rule === "limited") writeState(f.root, "jobs-local", { limitedUntil: now + 1 });
    if (rule === "known") writeState(f.root, "jobs-local", { jobs: { "job-1": { state: "approved" } } });
    if (["local", "origin"].includes(rule)) f.deps.git = async (_cwd, ...args) => ({ stdout: args[0] === (rule === "local" ? "for-each-ref" : "ls-remote") ? (rule === "local" ? "refs/heads/feat/job\n" : `${head}\trefs/heads/feat/job\n`) : "" });
    f.queue({}, "codex-job", rule === "wrong-leader" ? "other" : "leader");
    await jobsTick(f.deps);
    assert.equal(f.sent.at(-1).body.state, "refused");
    assert.ok(!f.calls.some(row => row.includes("worktree")));
  });
}
for (const repo of ["other/repo"]) {
  test(`worker refuses job repository ${repo} before git`, async t => {
    const f = fixture(t);
    writeState(f.root, "queue", [{ id: "foreign", repo, from: "leader", kind: "codex-job", body: f.body }]);
    await jobsTick(f.deps); await f.settle();
    assert.equal(f.sent.at(-1).body.state, "refused");
    assert.match(f.sent.at(-1).body.reason, /repository/);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(readState(f.root, "jobs-local"), {});
    assert.equal(readState(f.root, "queue").length, 0);
  });
  test(`worker refuses cancellation repository ${repo}`, async t => {
    const f = fixture(t); f.queue(); await jobsTick(f.deps); await f.settle();
    writeState(f.root, "queue", [{ id: "foreign", repo, from: "leader", kind: "codex-cancel", body: { id: "job-1" } }]);
    await jobsTick(f.deps); await f.settle();
    assert.equal(jobsHeartbeat(f.root).live, 1);
    assert.equal(f.sent.at(-1).body.state, "refused");
    assert.match(f.sent.at(-1).body.reason, /repository/);
    writeState(f.root, "queue", [{ id: "cancel", repo: "o/r", from: "leader", kind: "codex-cancel", body: { id: "job-1" } }]);
    await jobsTick(f.deps); await f.settle();
    assert.equal(f.sent.at(-1).body.state, "cancelled");
    assert.ok(!f.calls.some(row => row.includes("push") || row.includes("remove")));
  });
}
test("worker starts several jobs, reports steps, pushes approval without force, removes approved checkout", async t => {
  const f = fixture(t); f.queue(); await jobsTick(f.deps); await f.settle();
  assert.equal(f.sent[0].body.state, "started");
  const saved = readState(f.root, "jobs-local").jobs["job-1"];
  const brief = readFileSync(path.join(saved.dir, "implement.md"), "utf8");
  assert.ok(brief.includes(`Worktree: \`${saved.worktree}\``));
  assert.ok(brief.includes(path.join(saved.dir, "implement-progress.md")));
  assert.deepEqual(f.calls.find(row => row.includes("add")).slice(1), ["worktree", "add", "-b", "feat/job", saved.worktree, "origin/main"]);
  assert.deepEqual(f.calls.find(row => row[0] === "loop")[1], ["--dir", saved.dir, "--brief", "implement.md", "--rounds", "3", "--base", "origin/main"]);
  writeFileSync(path.join(saved.dir, "loop.status"), `${"old\n".repeat(30)}${"s".repeat(150)}\n`);
  assert.equal(jobsHeartbeat(f.root, f.fleet.secret).steps[0].step.length, 120);
  f.queue({ id: "job-2", branch: "feat/two" }); await jobsTick(f.deps); await f.settle();
  assert.equal(jobsHeartbeat(f.root).live, 2);
  f.queue({ id: "job-3" }); await jobsTick(f.deps);
  assert.equal(f.sent.at(-1).body.state, "refused");
  f.release({ code: 0 }); await f.settle();
  const approved = f.sent.filter(row => row.body.state === "approved");
  assert.equal(approved.length, 2); assert.equal(approved[0].body.head, head);
  assert.equal(approved[0].body.status.split("\n").length, 20);
  assert.ok(f.calls.some(row => row.slice(1).join(" ") === "push -u origin feat/job"));
  assert.ok(!f.calls.flat().includes("--force"));
  assert.equal(f.calls.filter(row => row.includes("remove")).length, 2);
  assert.equal(jobsHeartbeat(f.root).live, 0);
});
for (const code of [1, 2]) test(`worker exit ${code} keeps checkout and enforces limit window`, async t => {
  const f = fixture(t); f.queue(); await jobsTick(f.deps); await f.settle();
  f.release({ code }); await f.settle();
  assert.equal(f.sent.at(-1).body.state, code === 2 ? "limit" : "stopped");
  assert.ok(!f.calls.some(row => row.includes("push") || row.includes("remove")));
  if (code === 2) {
    assert.equal(jobsHeartbeat(f.root).limitedUntil, now + 3600000);
    f.queue({ id: "next" }); await jobsTick(f.deps); assert.equal(f.sent.at(-1).body.state, "refused");
    f.deps.clock = () => now + 3600000;
    writeState(f.root, "peers", { leader: { leader: true, term: 1, time: now + 3600000 } });
    f.queue({ id: "later" }); await jobsTick(f.deps); await f.settle();
    assert.ok(f.sent.some(row => row.body.id === "later" && row.body.state === "started"));
  }
});
test("cancel only from leader aborts job and keeps checkout", async t => {
  const f = fixture(t); f.queue(); await jobsTick(f.deps); await f.settle();
  f.queue({ id: "job-1" }, "codex-cancel", "other"); await jobsTick(f.deps);
  assert.equal(jobsHeartbeat(f.root).live, 1);
  writeState(f.root, "queue", [{ id: "cancel", from: "leader", kind: "codex-cancel", repo: "o/r", body: { id: "job-1" } }]);
  await jobsTick(f.deps); await f.settle();
  assert.equal(f.sent.at(-1).body.state, "cancelled");
  assert.ok(!f.calls.some(row => row.includes("push") || row.includes("remove")));
});
test("restart marks each live job failed once and keeps worktrees", async t => {
  const f = fixture(t);
  writeState(f.root, "jobs-local", { jobs: { old: { id: "old", state: "started", leader: "leader", repo: "o/r", worktree: "keep" } } });
  await recoverJobs(f.deps); await recoverJobs(f.deps);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].body.reason, "node restarted");
  assert.equal(readState(f.root, "jobs-local").jobs.old.worktree, "keep");
});
for (const secret of ["ab".repeat(32), "A".repeat(65), "CD".repeat(64)]) test(`worker redacts shared secret of length ${secret.length}`, async t => {
  const f = fixture(t); f.fleet.secret = secret;
  f.deps.git = async () => { throw new Error(`failed ${secret.toLowerCase()} ${secret.toUpperCase()}`); };
  f.queue(); await jobsTick(f.deps); await f.settle();
  assert.equal(f.sent.at(-1).body.state, "failed");
  assert.ok(!JSON.stringify(f.sent).toLowerCase().includes(secret.toLowerCase()));
  assert.match(f.sent.at(-1).body.reason, /REDACTED/);
});
test("loop spawns only qc codex-loop and abort stops process tree", async t => {
  const f = fixture(t), controller = new AbortController(), calls = [];
  const child = Object.assign(new EventEmitter(), { pid: 456, stdout: new PassThrough(), stderr: new PassThrough() });
  const result = runJobLoop(f.root, ["--dir", f.root], { signal: controller.signal,
    spawn: (command, args, opts) => { calls.push({ command, args, opts }); return child; },
    stopTree: async () => { calls.push("stopped"); child.emit("close", null); } });
  controller.abort();
  await result;
  assert.equal(calls[0].command, process.execPath);
  assert.equal(calls[0].args[1], "codex-loop");
  assert.ok(calls.includes("stopped"));
  assert.equal(calls[0].opts.shell, undefined);
});
for (const stage of ["fetch", "loop", "push", "remove"]) test(`worker ${stage} failure reports failed and keeps failed work`, async t => {
  const f = fixture(t), git = f.deps.git;
  if (stage === "loop") f.deps.loop = async () => { throw new Error("spawn failed"); };
  else f.deps.git = async (cwd, ...args) => { if (args.includes(stage)) throw new Error(`${stage} failed`); return git(cwd, ...args); };
  f.queue(); await jobsTick(f.deps); await f.settle();
  f.release({ code: 0 }); await f.settle();
  assert.equal(f.sent.at(-1).body.state, "failed");
  assert.match(f.sent.at(-1).body.reason, /failed/);
  if (stage !== "remove") assert.ok(!f.calls.some(row => row.includes("remove")));
});
test("leader change while branch checks wait prevents launch; queue row is removed before git", async t => {
  const f = fixture(t);
  f.deps.git = async () => {
    assert.equal(readState(f.root, "queue").length, 0);
    writeState(f.root, "peers", { other: { leader: true, term: 2, time: now } });
    return { stdout: "" };
  };
  f.queue(); await jobsTick(f.deps); await f.settle();
  assert.equal(f.sent.at(-1).body.state, "refused");
  assert.equal(jobsHeartbeat(f.root).live, 0);
});
for (const secret of ["ab".repeat(32), "A".repeat(65), "CD".repeat(64)]) test(`heartbeat and status redact shared secret of length ${secret.length}`, async t => {
  const f = fixture(t); f.fleet.secret = secret;
  f.queue(); await jobsTick(f.deps); await f.settle();
  const row = readState(f.root, "jobs-local").jobs["job-1"];
  writeFileSync(path.join(row.dir, "loop.status"), `${secret.toLowerCase()} ${secret.toUpperCase()}\n`);
  assert.ok(!JSON.stringify(jobsHeartbeat(f.root, secret)).toLowerCase().includes(secret.toLowerCase()));
  f.release({ code: 1 }); await f.settle();
  assert.ok(!JSON.stringify(f.sent.at(-1).body).toLowerCase().includes(secret.toLowerCase()));
});
test("loop spawn error rejects and a pre-aborted loop starts no child", async t => {
  const f = fixture(t), controller = new AbortController();
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const run = runJobLoop(f.root, [], { spawn: () => { queueMicrotask(() => child.emit("error", new Error("spawn failed"))); return child; } });
  await assert.rejects(run, /spawn failed/);
  controller.abort();
  await assert.rejects(runJobLoop(f.root, [], { signal: controller.signal, spawn: () => { assert.fail("unexpected spawn"); } }), /abort/i);
});
