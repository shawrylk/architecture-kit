import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { connect } from "node:net";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createMessage, verifyMessage } from "./fleet-message.mjs";
import { readState, stateDir, writeState } from "./fleet-state.mjs";
import { createNodeServer, sendMessage, flushOutbox, heartbeat, startNode, stopNode, nodeStatus, serveNode } from "./fleet-node.mjs";

const secret = "ab".repeat(32);
const now = Date.parse("2026-11-24T00:00:00Z");
const fleet = { self: "a", secret, nodes: [
  { id: "a", address: "127.0.0.1", port: 8080 },
  { id: "b", address: "127.0.0.1", port: 8081, active: true },
  { id: "inactive", address: "localhost", port: 8082, active: false },
  { id: "unaddressed" },
] };
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-node-"));
  mkdirSync(path.join(root, ".git"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}
const message = (fields = {}) => createMessage({ from: "b", repo: "o/r", kind: "question", body: { command: "do not execute" }, time: new Date(now).toISOString(), ...fields }, secret);

test("HTTP routes, JSON, signature refusal, replay, byte limit and durable queue append", async t => {
  const root = fixture(t);
  const server = await createNodeServer({ root, fleet, clock: () => now, listen: { port: 0 } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(server.address().address, fleet.nodes[0].address);
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.match(healthBody.instance, /^[0-9a-f-]{36}$/);
  for (const [route, method] of [["/", "GET"], ["/message", "GET"], ["/health", "POST"], ["/health?x=1", "GET"]]) {
    assert.equal((await fetch(base + route, { method })).status, 404);
  }
  const post = body => fetch(`${base}/message`, { method: "POST", body });
  assert.equal((await post("{")).status, 400);
  const invalid = await post(JSON.stringify({ ...message(), sig: "00".repeat(32) }));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { ok: false, reason: "bad-signature" });
  const first = message();
  assert.equal((await post(JSON.stringify(first))).status, 202);
  const replay = await post(JSON.stringify(first));
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).reason, "seen-id");
  // Signed JSON of exactly 64 KiB is accepted; a multibyte body over it is refused.
  const sized = message({ body: { text: "" } });
  const padding = 65536 - Buffer.byteLength(JSON.stringify(sized));
  const edge = message({ id: sized.id, body: { text: "x".repeat(padding) } });
  assert.equal(Buffer.byteLength(JSON.stringify(edge)), 65536);
  assert.equal((await post(JSON.stringify(edge))).status, 202);
  assert.equal((await post(JSON.stringify(message({ body: { text: "é".repeat(33000) } })))).status, 413);
  assert.deepEqual(readState(root, "queue"), [first, edge]);
  assert.deepEqual(Object.keys(readState(root, "seen")).sort(), [first.id, edge.id].sort());
  // A new server must use the saved IDs too.
  await new Promise(resolve => server.close(resolve));
  const restarted = await createNodeServer({ root, fleet, clock: () => now, listen: { port: 0 } });
  t.after(() => new Promise(resolve => restarted.close(resolve)));
  const savedReplay = await fetch(`http://127.0.0.1:${restarted.address().port}/message`, { method: "POST", body: JSON.stringify(first) });
  assert.equal((await savedReplay.json()).reason, "seen-id");
});

test("failed client sends persist and retries use oldest-first exponential backoff capped at 60 seconds", async t => {
  const root = fixture(t);
  let time = now;
  const calls = [];
  let fail = true;
  const fetch = async (url, options) => {
    assert.equal(options.method, "POST");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    calls.push(JSON.parse(options.body).id);
    if (fail) throw new Error("offline");
    return { status: 202 };
  };
  const opts = { root, fleet, fetch, clock: () => time };
  const first = message(), second = message();
  assert.equal(await sendMessage({ ...opts, node: fleet.nodes[1], message: first }), false);
  assert.equal(await sendMessage({ ...opts, node: fleet.nodes[1], message: second }), false);
  assert.equal(readState(root, "outbox")[0].nextAttempt, now + 1000);
  await flushOutbox(opts);
  assert.deepEqual(calls, [first.id, second.id]);
  for (const delay of [2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    time = readState(root, "outbox")[0].nextAttempt;
    await flushOutbox(opts);
    assert.equal(calls.at(-1), first.id);
    assert.equal(readState(root, "outbox")[0].nextAttempt, time + delay);
  }
  fail = false;
  time = readState(root, "outbox")[0].nextAttempt;
  calls.length = 0;
  await flushOutbox(opts);
  assert.deepEqual(calls, [first.id, second.id]);
  assert.deepEqual(readState(root, "outbox"), []);
  assert.equal(await sendMessage({ ...opts, node: fleet.nodes[1], message: first, fetch: async () => ({ status: 500 }) }), false);
  writeState(root, "outbox", []);
  calls.length = 0;
  assert.equal(await sendMessage({ ...opts, node: fleet.nodes[1], message: second, signal: AbortSignal.abort() }), false);
  assert.deepEqual(calls, [], "an aborted signal starts no request");
  assert.deepEqual(readState(root, "outbox").map(entry => entry.message.id), [second.id]);
});

test("heartbeat targets only other active addressed nodes and records receipt time, kit and leader", async t => {
  const root = fixture(t);
  const received = [];
  await heartbeat({ root, fleet, repo: "o/r", kit: "commit", leader: true, clock: () => now,
    fetch: async (url, options) => { received.push({ url, message: JSON.parse(options.body) }); return { status: 202 }; } });
  assert.equal(received.length, 1);
  assert.equal(received[0].url, "http://127.0.0.1:8081/message");
  assert.equal(received[0].message.kind, "heartbeat");
  assert.deepEqual(received[0].message.body, { kit: "commit", leader: true });
  const server = await createNodeServer({ root, fleet, clock: () => now, listen: { port: 0 } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/message`, { method: "POST", body: JSON.stringify(body) });
  const beat = message({ kind: "heartbeat", body: { kit: null, leader: false } });
  assert.equal((await post(beat)).status, 202);
  assert.deepEqual(readState(root, "peers"), { b: { time: now, kit: null, leader: false } });
  assert.equal((await post(message({ kind: "heartbeat", body: { leader: "yes" } }))).status, 400);
  assert.deepEqual(readState(root, "queue"), []);
});

test("regression: a peer offline for four heartbeat ticks leaves the outbox empty", async t => {
  const root = fixture(t), signals = new Map();
  let time = now, tick;
  const sent = [];
  const server = await serveNode({ root, fleet, repo: "o/r", clock: () => time, listen: { port: 0 },
    timer: fn => { tick = fn; }, clearTimer() {},
    onSignal: (name, fn) => signals.set(name, fn), offSignal: name => signals.delete(name),
    fetch: async (_url, options) => { sent.push(JSON.parse(options.body)); throw new Error("offline"); } });
  t.after(async () => { const closed = once(server, "close"); signals.get("SIGTERM")(); await closed; });
  for (let i = 0; i < 4; i++) {
    time += 30_000;
    await tick();
  }
  assert.deepEqual(readState(root, "outbox"), []);
  assert.equal(sent.length, 4);
  assert.equal(new Set(sent.map(item => item.id)).size, 4);
});

test("regression: stop ends a child with a hung peer and starts no further sends", { timeout: 30_000 }, async t => {
  for (const kind of ["heartbeat", "outbox"]) await t.test(kind, { timeout: 10_000 }, async t => {
    const root = fixture(t), sockets = new Set();
    let requests = 0, accept;
    const accepted = new Promise(resolve => { accept = resolve; });
    const peer = createServer(req => { requests++; req.resume(); accept(); });
    peer.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise(resolve => peer.listen(0, "127.0.0.1", resolve));
    t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => peer.close(resolve)); });
    const nodes = { ...fleet, nodes: [
      { id: "a", address: "127.0.0.1", port: 0 },
      { id: "b", address: "127.0.0.1", port: peer.address().port },
      { id: "c", address: "127.0.0.1", port: peer.address().port },
    ] };
    if (kind === "outbox") writeState(root, "outbox", ["b", "c"].map(node => ({
      node, message: message(), attempts: 1, nextAttempt: now,
    })));
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { serveNode } from ${JSON.stringify(new URL("./fleet-node.mjs", import.meta.url).href)};
      let time = ${now};
      const server = await serveNode({ root: ${JSON.stringify(root)}, fleet: ${JSON.stringify(nodes)}, repo: "o/r",
        clock: () => time, listen: { port: 0 }, timer: fn => setInterval(() => {
          time = ${now} + ${kind === "heartbeat" ? 30_000 : 1000};
          void fn();
        }, 20) });
      console.log(server.address().port);
    `], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit");
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
    const [output] = await once(child.stdout, "data");
    nodes.nodes[0].port = Number(output.toString().trim());
    await accepted;
    const started = Date.now();
    assert.deepEqual(await stopNode({ root, fleet: nodes }), { stopped: true, already: false });
    const [code, signal] = await exited;
    assert.equal(code, process.platform === "win32" ? 1 : 0);
    assert.equal(signal, null);
    assert.ok(Date.now() - started < 5000);
    assert.equal(requests, 1);
    assert.equal(existsSync(path.join(stateDir(root), "node.json")), false);
  });
});

test("node:http client sends to the server and queues network failure", async t => {
  const root = fixture(t);
  const server = await createNodeServer({ root, fleet, clock: () => now, listen: { port: 0 } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const node = { ...fleet.nodes[0], port: server.address().port };
  const first = message();
  assert.equal(await sendMessage({ root, fleet, node, message: first, clock: () => now }), true);
  assert.deepEqual(readState(root, "queue"), [first]);
  await new Promise(resolve => server.close(resolve));
  assert.equal(await sendMessage({ root, fleet, node, message: message(), clock: () => now }), false);
  assert.equal(readState(root, "outbox").length, 1);
});

function processDeps(root) {
  let time = now, live = false, ready = true, stubborn = false;
  const spawned = [], signals = [];
  const deps = { root, fleet, clock: () => time, sleep: async ms => { time += ms; },
    spawn: (command, args, options) => {
      spawned.push({ command, args, options });
      live = true;
      return { pid: 12345, unref() {}, once() {} };
    },
    kill: (pid, signal) => {
      assert.equal(pid, 12345);
      signals.push(signal);
      if (!live) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      if (signal !== 0 && !stubborn) live = false;
    },
    fetch: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:8080/health");
      assert.ok(options.signal instanceof AbortSignal);
      if (!ready) throw new Error("not ready");
      return { status: 200, json: async () => ({ ok: true, instance: spawned.at(-1)?.options.env.QC_FLEET_INSTANCE }) };
    },
  };
  return { deps, spawned, signals, setReady: value => { ready = value; }, setStubborn: value => { stubborn = value; }, setLive: value => { live = value; }, time: () => time };
}

test("start detaches with a log, start twice is idempotent, stop keeps state and stopped stop succeeds", async t => {
  const root = fixture(t);
  writeState(root, "queue", [message()]);
  writeState(root, "outbox", [{ id: "pending" }]);
  writeState(root, "peers", { b: { time: now, leader: true, kit: null } });
  const p = processDeps(root);
  assert.deepEqual(await startNode({ ...p.deps, leader: true }), { running: true, already: false });
  assert.deepEqual(readState(root, "node"), { pid: 12345, leader: true, instance: p.spawned[0].options.env.QC_FLEET_INSTANCE });
  assert.equal(p.spawned.length, 1);
  const spawned = p.spawned[0];
  assert.equal(spawned.command, process.execPath);
  assert.deepEqual(spawned.args.slice(-3), ["fleet", "serve", "--leader"]);
  assert.equal(spawned.options.detached, true);
  assert.equal(spawned.options.cwd, root);
  assert.equal(spawned.options.stdio[0], "ignore");
  assert.equal(spawned.options.stdio[1], spawned.options.stdio[2]);
  assert.equal(readFileSync(path.join(stateDir(root), "node.log"), "utf8"), "");
  assert.deepEqual(await startNode(p.deps), { running: true, already: true });
  assert.equal(p.spawned.length, 1);
  assert.equal(await nodeStatus(p.deps), "node=running leader=a peers=1/3");
  assert.deepEqual(await stopNode(p.deps), { stopped: true, already: false });
  assert.ok(p.signals.includes("SIGTERM"));
  assert.equal(existsSync(path.join(stateDir(root), "node.json")), false);
  assert.equal(readState(root, "queue").length, 1);
  assert.equal(readState(root, "outbox").length, 1);
  assert.equal(readState(root, "peers").b.leader, true);
  assert.equal(existsSync(path.join(stateDir(root), "node.log")), true);
  assert.deepEqual(await stopNode(p.deps), { stopped: true, already: true });
  assert.equal(await nodeStatus(p.deps), "node=stopped leader=b peers=1/3");
  assert.equal(await nodeStatus({ ...p.deps, clock: () => now + 90_001 }), "node=stopped leader=unknown peers=0/3");
});

test("start names missing secret/address, times out and cleans up; stale records and stop timeout", async t => {
  const root = fixture(t), p = processDeps(root);
  await assert.rejects(startNode({ ...p.deps, fleet: { ...fleet, secret: undefined } }), /secret/);
  await assert.rejects(startNode({ ...p.deps, fleet: { ...fleet, nodes: [{ id: "a" }] } }), /address.*a/);
  assert.equal(p.spawned.length, 0);
  p.setReady(false);
  await assert.rejects(startNode(p.deps), /health.*5 s/);
  assert.equal(p.time() - now, 5000);
  assert.equal(existsSync(path.join(stateDir(root), "node.json")), false);
  writeState(root, "node", { pid: 12345, leader: true, instance: p.spawned[0].options.env.QC_FLEET_INSTANCE });
  p.setLive(false);
  p.setReady(true);
  assert.deepEqual(await stopNode(p.deps), { stopped: true, already: true });
  p.setReady(true);
  await startNode(p.deps);
  p.setStubborn(true);
  await assert.rejects(stopNode(p.deps), /stop.*5 s/);
  assert.equal(readState(root, "node").pid, 12345);
  p.setLive(false);
  assert.deepEqual(await startNode(p.deps), { running: true, already: false });
});

test("status counts only known other senders in the inclusive 90-second window", async t => {
  const root = fixture(t), p = processDeps(root);
  writeState(root, "peers", { a: { time: now, leader: true }, b: { time: now - 90000, leader: true },
    inactive: { time: now - 90001, leader: true }, unaddressed: { time: now + 1, leader: true }, unknown: { time: now, leader: true } });
  assert.equal(await nodeStatus(p.deps), "node=stopped leader=b peers=1/3");
});

test("serve schedules heartbeats every 30 seconds, retries every second and closes cleanly", async t => {
  const root = fixture(t);
  let time = now;
  const timers = [], signals = new Map(), sent = [], cleared = [];
  const server = await serveNode({ root, fleet, repo: "o/r", kit: null, leader: true, clock: () => time,
    listen: { port: 0 }, pid: 12345, timer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimer: timer => cleared.push(timer), onSignal: (name, fn) => signals.set(name, fn), offSignal: name => signals.delete(name),
    fetch: async (url, options) => { sent.push(JSON.parse(options.body)); return { status: 202 }; } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.deepEqual(timers.map(timer => timer.ms), [1000]);
  time += 29000;
  await timers[0].fn();
  assert.equal(sent.length, 0);
  time += 1000;
  await timers[0].fn();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, { kit: null, leader: true });
  assert.equal(readState(root, "node").leader, true);
  const closed = new Promise(resolve => server.once("close", resolve));
  signals.get("SIGTERM")();
  await closed;
  assert.equal(cleared.length, 1);
  assert.equal(signals.size, 0);
  assert.equal(existsSync(path.join(stateDir(root), "node.json")), false);
});

test("server refuses addresses that resolve to wildcard interfaces", async t => {
  const root = fixture(t);
  for (const address of ["0.0.0.0", "::", "0", "0:0:0:0:0:0:0:0"]) {
    await assert.rejects(createNodeServer({ root, fleet: { ...fleet, nodes: [{ id: "a", address }] }, listen: { port: 0 } }), /address.*interface/);
  }
  await assert.rejects(createNodeServer({ root, fleet: { ...fleet, nodes: [{ id: "a", address: "node.invalid" }] }, listen: { port: 0 } }),
    { message: "node a address node.invalid does not resolve to an interface" });
});

test("status remains available outside a checkout with no process or peer state", async t => {
  const root = fixture(t);
  rmSync(path.join(root, ".git"), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  assert.equal(await nodeStatus({ root, fleet }), "node=stopped leader=unknown peers=0/3");
});


test("regression: lifecycle requires the saved instance before readiness or signals", async t => {
  await t.test("start saves and passes a random instance, and waits for that instance", async t => {
    const root = fixture(t), p = processDeps(root);
    const observed = [];
    p.deps.fetch = async () => {
      const instance = readState(root, "node").instance;
      observed.push(instance);
      return { status: 200, json: async () => ({ ok: true, instance }) };
    };
    await startNode(p.deps);
    const record = readState(root, "node");
    assert.match(record.instance, /^[0-9a-f-]{36}$/);
    assert.equal(p.spawned[0].options.env.QC_FLEET_INSTANCE, record.instance);
    assert.ok(observed.includes(record.instance));
    p.setLive(false);
    await startNode(p.deps);
    assert.notEqual(readState(root, "node").instance, record.instance);
  });
  await t.test("another listener cannot make a new child ready or receive cleanup signals", async t => {
    const root = fixture(t), p = processDeps(root);
    p.deps.fetch = async () => ({ status: 200, json: async () => ({ ok: true, instance: "another-instance" }) });
    await assert.rejects(startNode(p.deps), /stale|health.*5 s/);
    assert.deepEqual(p.signals, []);
  });
  await t.test("status, stop and repeated start reject a reused PID without signaling it", async t => {
    const root = fixture(t), p = processDeps(root);
    writeState(root, "node", { pid: 12345, leader: true, instance: "saved-instance" });
    p.setLive(true);
    p.deps.fetch = async () => ({ status: 200, json: async () => ({ ok: true, instance: "another-instance" }) });
    assert.equal(await nodeStatus(p.deps), "node=stale leader=unknown peers=0/3");
    await assert.rejects(stopNode(p.deps), /stale/);
    await assert.rejects(startNode(p.deps), /stale/);
    assert.deepEqual(p.signals, []);
    assert.equal(p.spawned.length, 0);
    assert.equal(readState(root, "node").instance, "saved-instance");
  });
});

test("regression: heartbeats update peers without growing the work queue", async t => {
  const root = fixture(t), queued = message();
  writeState(root, "queue", [queued]);
  const server = await createNodeServer({ root, fleet, clock: () => now, listen: { port: 0 } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/message`, { method: "POST", body: JSON.stringify(body) });
  const beats = Array.from({ length: 4 }, () => message({ kind: "heartbeat", body: { kit: null, leader: false } }));
  for (const beat of beats) assert.equal((await post(beat)).status, 202);
  assert.deepEqual(readState(root, "queue"), [queued]);
  assert.deepEqual(readState(root, "peers"), { b: { time: now, kit: null, leader: false } });
  assert.equal((await post(beats[0])).status, 400);
});

test("regression: outbox retries sign unsigned fixed IDs at the current time", async t => {
  const root = fixture(t);
  let time = now;
  const original = message();
  await sendMessage({ root, fleet, node: fleet.nodes[1], message: original, clock: () => time,
    fetch: async () => { throw new Error("offline"); } });
  const saved = readState(root, "outbox")[0].message;
  assert.equal(saved.sig, undefined);
  assert.equal(saved.time, undefined);
  assert.equal(saved.id, original.id);
  time += 600_001;
  let retry;
  await flushOutbox({ root, fleet, clock: () => time, fetch: async (_url, options) => {
    retry = JSON.parse(options.body);
    assert.equal(retry.id, original.id);
    assert.equal(retry.time, new Date(time).toISOString());
    const checked = verifyMessage(retry, { secret, nodes: fleet.nodes, now: time });
    return { status: checked.ok ? 202 : 400, json: async () => checked };
  } });
  assert.ok(retry);
  assert.notEqual(retry.sig, original.sig);
  assert.deepEqual(readState(root, "outbox"), []);
});

test("regression: terminal outbox replies drain and dead letters keep only the last 100", async t => {
  const root = fixture(t);
  let time = now;
  const messages = Array.from({ length: 104 }, () => message());
  const opts = { root, fleet, clock: () => time };
  for (const item of messages) await sendMessage({ ...opts, node: fleet.nodes[1], message: item,
    fetch: async () => { throw new Error("offline"); } });
  time += 1000;
  let calls = 0;
  await flushOutbox({ ...opts, fetch: async () => {
    const index = calls++;
    return { status: index === 0 ? 400 : index === 103 ? 202 : 422,
      json: async () => ({ ok: false, reason: index === 0 ? "seen-id" : "bad-repo" }) };
  } });
  assert.deepEqual(readState(root, "outbox"), []);
  assert.equal(calls, 104);
  const dead = readState(root, "dead");
  assert.equal(dead.length, 100);
  assert.deepEqual(dead.map(entry => entry.message.id), messages.slice(3, 103).map(item => item.id));
  assert.equal(dead[0].status, 422);
  assert.equal(dead[0].reason, "bad-repo");
  assert.equal(await sendMessage({ ...opts, node: fleet.nodes[1], message: message(),
    fetch: async () => ({ status: 400, json: async () => ({ reason: "seen-id" }) }) }), true);
  assert.equal(await sendMessage({ ...opts, node: fleet.nodes[1], message: message(),
    fetch: async () => ({ status: 403, json: async () => { throw new Error("not JSON"); } }) }), false);
  assert.equal(readState(root, "dead").length, 100);
  assert.equal(readState(root, "dead").at(-1).status, 403);
  await sendMessage({ ...opts, node: fleet.nodes[1], message: message(), fetch: async () => ({ status: 503 }) });
  assert.equal(readState(root, "outbox").length, 1);
});

test("regression: SIGTERM closes a partial request within the stop deadline", async t => {
  const root = fixture(t), signals = new Map();
  const server = await serveNode({ root, fleet, repo: "o/r", listen: { port: 0 }, instance: "shutdown-instance",
    onSignal: (name, fn) => signals.set(name, fn), offSignal: name => signals.delete(name) });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const socket = connect({ host: "127.0.0.1", port: server.address().port });
  t.after(() => socket.destroy());
  await once(socket, "connect");
  socket.write("POST /message HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{");
  await new Promise(resolve => setImmediate(resolve));
  let timeout;
  const closed = once(server, "close").then(() => true);
  signals.get("SIGTERM")();
  assert.equal(server.listening, false);
  try {
    const bounded = new Promise(resolve => { timeout = setTimeout(() => resolve(false), 1800); });
    assert.equal(await Promise.race([closed, bounded]), true, "shutdown must force-close partial requests after 1 s");
  } finally { clearTimeout(timeout); }
  assert.equal(server.requestTimeout, 10_000);
  assert.equal(existsSync(path.join(stateDir(root), "node.json")), false);
});
