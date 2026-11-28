import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { dispatchTick, parseDispatchArgs, pickJobNode, runDispatch } from "./fleet-dispatch.mjs";
import { runWatch } from "./watch.mjs";
import { readState, writeState } from "./fleet-state.mjs";

const now = 100000, head = "a".repeat(40);
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-dispatch-"));
  mkdirSync(path.join(root, ".git"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const fleet = { self: "a", secret: "ab".repeat(32), nodes: ["a", "b", "c", "dead", "full", "limited", "hot", "off", "no-address"].map(id => ({ id, address: "localhost", port: 8080, active: id !== "off" })) };
  delete fleet.nodes.at(-1).address;
  const peer = (max, live = 0, extra = {}) => ({ time: now, load: { cpu: 0.2, mem: 0.2, rtt: 10 }, jobs: { max, live, limitedUntil: 0, steps: [] }, ...extra });
  const peers = { a: peer(2), b: peer(6, 1), c: peer(6, 1), dead: peer(20, 0, { time: now - 90000 }), full: peer(2, 2), limited: peer(20, 0), hot: peer(20, 0, { load: { cpu: 0.9 } }), off: peer(20), "no-address": peer(20) };
  peers.limited.jobs.limitedUntil = now + 1;
  writeState(root, "node", { leader: true, term: 1 }); writeState(root, "peers", peers);
  const brief = path.join(root, "brief.md"); writeFileSync(brief, "Worktree: `old`\n");
  const sent = [], lines = [];
  const deps = { root, fleet, repo: "o/r", clock: () => now, say: line => lines.push(line), fetch: async (_url, options) => { sent.push(JSON.parse(options.body)); return { status: 202 }; } };
  const args = ["--brief", brief, "--branch", "feat/worker", "--base", "main"];
  const queue = (body, from = "b", repo = "o/r") => writeState(root, "queue", [...readState(root, "queue"), { id: String(Math.random()), kind: "codex-result", from, repo, body }]);
  return { root, fleet, peers, brief, sent, lines, deps, args, queue };
}
test("node pick uses free slots, load, limits, live status and id; leader can work", t => {
  const f = fixture(t);
  assert.equal(pickJobNode({ fleet: f.fleet, peers: f.peers, now }).id, "b");
  f.peers.c.jobs.live = 0;
  assert.equal(pickJobNode({ fleet: f.fleet, peers: f.peers, now }).id, "c");
  for (const id of ["b", "c"]) f.peers[id].jobs.max = 0;
  assert.equal(pickJobNode({ fleet: f.fleet, peers: f.peers, now }).id, "a");
  assert.throws(() => pickJobNode({ fleet: f.fleet, peers: f.peers, now, node: "dead" }), /live|available/);
});
test("job and cancel require current leader; malformed arguments fail", async t => {
  const f = fixture(t);
  writeState(f.root, "node", { leader: false });
  await assert.rejects(runDispatch(parseDispatchArgs("job", f.args), f.deps), /leader/i);
  await assert.rejects(runDispatch(parseDispatchArgs("cancel", ["job"]), f.deps), /leader/i);
  assert.equal(f.sent.length, 0);
  for (const args of [[], [...f.args, "--rounds", "7"], [...f.args, "--id", "../bad"], [...f.args, "--node", "b", "--node", "c"]]) assert.throws(() => parseDispatchArgs("job", args));
});
test("dispatch queues job, stores row, prints state and sends cancel to saved node", async t => {
  const f = fixture(t);
  assert.equal(await runDispatch(parseDispatchArgs("job", f.args), f.deps), 0);
  const row = Object.values(readState(f.root, "jobs"))[0];
  assert.match(row.id, /^feat-worker-[0-9a-f]{4}$/); assert.equal(row.node, "b");
  assert.equal(f.sent[0].kind, "codex-job"); assert.equal(f.sent[0].body.rounds, 3);
  assert.equal(readState(f.root, "outbox").length, 0);
  await runDispatch(parseDispatchArgs("jobs", []), f.deps);
  assert.match(f.lines.at(-1), new RegExp(`${row.id} b queued feat/worker - 0s`));
  await runDispatch(parseDispatchArgs("cancel", [row.id]), f.deps);
  assert.deepEqual(f.sent.at(-1).body, { id: row.id }); assert.equal(f.sent.at(-1).kind, "codex-cancel");
  await assert.rejects(runDispatch(parseDispatchArgs("job", [...f.args, "--id", row.id]), f.deps), /known/);
});
test("transport failure keeps dispatch in durable outbox; leader demotion blocks retry", async t => {
  const f = fixture(t);
  await runDispatch(parseDispatchArgs("job", f.args), { ...f.deps, fetch: async () => { throw new Error("offline"); } });
  assert.equal(readState(f.root, "outbox").length, 1);
  writeState(f.root, "node", { leader: false, term: 2 });
  const { flushOutbox } = await import("./fleet-node.mjs");
  await flushOutbox(f.deps);
  assert.equal(f.sent.length, 0); assert.equal(readState(f.root, "outbox").length, 0);
});
test("result validates node, repo and fields; watch receives each event once; lost is emitted once", async t => {
  const f = fixture(t);
  await runDispatch(parseDispatchArgs("job", [...f.args, "--id", "job"]), f.deps);
  f.queue({ id: "job", state: "approved", branch: "feat/worker", head }, "c");
  f.queue({ id: "job", state: "approved", branch: "feat/worker", head }, "b", "other/repo");
  f.queue({ id: "job", state: "approved", branch: "wrong", head });
  f.queue({ id: "job", state: "approved", branch: "feat/worker", head: "no" });
  dispatchTick(f.deps);
  assert.equal(readState(f.root, "jobs").job.state, "queued");
  f.queue({ id: "job", state: "started", branch: "feat/worker" }); dispatchTick(f.deps);
  const events = [];
  assert.equal(await runWatch(["--fleet"], { cwd: f.root, say: line => events.push(line) }), 0);
  assert.deepEqual(events, ["EVENT fleet:codex-result job started feat/worker -"]);
  const peers = readState(f.root, "peers"); peers.b.jobs.steps = [{ id: "job", step: "loop-review-1 exit 0 APPROVED" }]; writeState(f.root, "peers", peers);
  await runDispatch(parseDispatchArgs("jobs", []), f.deps); assert.match(f.lines.at(-1), /loop-review-1 exit 0 APPROVED/);
  dispatchTick({ ...f.deps, clock: () => now + 90000 }); dispatchTick({ ...f.deps, clock: () => now + 90001 });
  assert.equal(readState(f.root, "jobs").job.state, "lost");
  assert.equal(readState(f.root, "inbox").filter(row => row.detail?.includes(" lost ")).length, 1);
  assert.equal(await runWatch(["--fleet"], { cwd: f.root, say: line => events.push(line) }), 0);
  assert.equal(events.at(-1), "EVENT fleet:codex-result job lost feat/worker -");
  f.queue({ id: "job", state: "approved", branch: "feat/worker", head, status: "DONE APPROVED" }); dispatchTick(f.deps);
  assert.equal(readState(f.root, "jobs").job.state, "approved");
  assert.equal(await runWatch(["--fleet"], { cwd: f.root, say: line => events.push(line) }), 0);
  assert.equal(events.at(-1), `EVENT fleet:codex-result job approved feat/worker ${head}`);
  f.queue({ id: "job", state: "refused", branch: "feat/worker", reason: "job id already known" });
  f.queue({ id: "job", state: "stopped", branch: "feat/worker", status: "STOP late" }); dispatchTick(f.deps);
  assert.equal(readState(f.root, "jobs").job.state, "approved");
});

test("a refusal after the worker started the job does not replace its state; jobs prints - for an empty step", async t => {
  const f = fixture(t);
  await runDispatch(parseDispatchArgs("job", [...f.args, "--id", "job"]), f.deps);
  f.queue({ id: "job", state: "started", branch: "feat/worker" }); dispatchTick(f.deps);
  f.queue({ id: "job", state: "refused", branch: "feat/worker", reason: "late" }); dispatchTick(f.deps);
  assert.equal(readState(f.root, "jobs").job.state, "started");
  const peers = readState(f.root, "peers"); peers.b.jobs.steps = [{ id: "job", step: "" }]; writeState(f.root, "peers", peers);
  await runDispatch(parseDispatchArgs("jobs", []), f.deps); assert.match(f.lines.at(-1), /^job b started feat\/worker - \d+s$/);
});
test("dispatch never sends fleet secret in brief and detects folder read error", async t => {
  const f = fixture(t);
  writeFileSync(f.brief, f.fleet.secret);
  await assert.rejects(runDispatch(parseDispatchArgs("job", f.args), f.deps), /secret/);
  await assert.rejects(runDispatch(parseDispatchArgs("job", ["--brief", f.root, "--branch", "feat/x", "--base", "main"]), f.deps), /EISDIR|EPERM|EACCES/);
  assert.equal(f.sent.length, 0);
});
