import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getDefaultResultOrder, setDefaultResultOrder } from "node:dns";
import { connect } from "node:net";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createMessage, verifyMessage } from "./fleet-message.mjs";
import { readState, stateDir, writeState } from "./fleet-state.mjs";
import { createNodeServer, sendMessage, flushOutbox, heartbeat as sendHeartbeat, startNode, stopNode, nodeStatus, serveNode as runNode } from "./fleet-node.mjs";
import { runFleet } from "./fleet.mjs";
import { assignTick } from "./fleet-assign.mjs";

const idleOS = { cpus: () => [{ times: { user: 10, idle: 90 } }], freemem: () => 50, totalmem: () => 100 };
const serveNode = options => runNode({ os: idleOS, ...options });
const heartbeat = options => sendHeartbeat({ os: idleOS, ...options });
const initialLoad = { cpu: null, mem: 0.5, rtt: null };

const host = process.platform === "win32" ? "windows" : process.platform;
const apiResponse = args => JSON.stringify(args[1] === "user" ? { login: "me" } : []);
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
  await heartbeat({ root, fleet, repo: "o/r", kit: "commit", term: 1, leader: true, clock: () => now,
    fetch: async (url, options) => { received.push({ url, message: JSON.parse(options.body) }); return { status: 202 }; } });
  assert.equal(received.length, 1);
  assert.equal(received[0].url, "http://127.0.0.1:8081/message");
  assert.equal(received[0].message.kind, "heartbeat");
  assert.equal(received[0].message.body.os, process.platform === "win32" ? "windows" : process.platform);
  assert.deepEqual(received[0].message.body, { load: initialLoad, kit: "commit", os: process.platform === "win32" ? "windows" : process.platform, term: 1, leader: true, work: [], assigned: [] });
  const server = await createNodeServer({ root, fleet, clock: () => now, listen: { port: 0 } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/message`, { method: "POST", body: JSON.stringify(body) });
  const beat = message({ kind: "heartbeat", body: { kit: null, term: 1, leader: false } });
  assert.equal((await post(beat)).status, 202);
  assert.deepEqual(readState(root, "peers"), { a: { load: { ...initialLoad, rtt: 0 }, time: now, os: host, kit: "commit", term: 1, leader: true, work: [], assigned: [] }, b: { time: now, messageTime: beat.time, kit: null, term: 1, leader: false } });
  assert.equal((await post(message({ kind: "heartbeat", body: { leader: "yes" } }))).status, 400);
  assert.deepEqual(readState(root, "queue"), []);
});

test("heartbeat ordering saves signed time and ignores older or equal snapshots after restart", async t => {
  const root = fixture(t);
  let time = now + 1000;
  const start = () => createNodeServer({ root, fleet, clock: () => time, listen: { port: 0 } });
  let server = await start();
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = (sent, body) => fetch(`http://127.0.0.1:${server.address().port}/message`, { method: "POST",
    body: JSON.stringify(message({ kind: "heartbeat", time: new Date(sent).toISOString(), body })) });
  const body = { kit: "new", term: 1, leader: true, work: [], assigned: [] };
  assert.equal((await post(now, body)).status, 202);
  const saved = readState(root, "peers");
  assert.equal(saved.b.messageTime, new Date(now).toISOString());
  assert.equal(saved.b.time, time, "liveness still uses receipt time");
  await new Promise(resolve => server.close(resolve));
  server = await start();
  for (const sent of [now - 1, now]) {
    time++;
    assert.equal((await post(sent, { kit: "old", term: 1, leader: false })).status, 202);
    assert.deepEqual(readState(root, "peers"), { ...saved, b: { ...saved.b, time } },
      "older or equal heartbeats refresh receipt time while preserving snapshot fields");
  }
  assert.equal((await post(now + 1, { kit: null, term: 1, leader: false })).status, 202);
  assert.deepEqual(readState(root, "peers").b, { time, messageTime: new Date(now + 1).toISOString(), kit: null, term: 1, leader: false });
});

test("regression: a sender clock rollback keeps live work at epoch 1", async t => {
  const root = fixture(t);
  let time = now;
  const server = await createNodeServer({ root, fleet, clock: () => time, listen: { port: 0 } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = sent => fetch(`http://127.0.0.1:${server.address().port}/message`, { method: "POST",
    body: JSON.stringify(message({ kind: "heartbeat", time: new Date(sent).toISOString(),
      body: { kit: "kit", term: 1, leader: false, work: [] } })) });
  assert.equal((await post(now + 240_000)).status, 202);
  for (const seconds of [30, 60, 90, 120]) {
    time = now + seconds * 1000;
    assert.equal((await post(time)).status, 202);
  }
  const assignment = { repo: "o/r", issue: 7, node: "b", epoch: 1, time: now, size: "M" };
  const peers = readState(root, "peers");
  const result = assignTick({ fleet: { ...fleet, nodes: fleet.nodes.map(node => ({ ...node, weight: 1, maxSize: "L" })) },
    repo: "o/r", kit: "kit", now: time, open: new Set([7]), free: [],
    assignments: { "o/r#7": assignment }, peers });
  assert.deepEqual(result.assignments["o/r#7"], assignment, "a live worker keeps #7 at epoch 1");
  assert.equal(peers.b.time, time, "each valid heartbeat refreshes receipt time");
  assert.equal(peers.b.messageTime, new Date(now + 240_000).toISOString());
});

test("regression: a peer offline for four heartbeat ticks leaves the outbox empty", async t => {
  const root = fixture(t), signals = new Map();
  let time = now, tick;
  const sent = [];
  const server = await serveNode({ root, fleet, repo: "o/r", clock: () => time, listen: { port: 0 },
    gh: apiResponse, timer: fn => { tick = fn; }, clearTimer() {},
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
        gh: args => JSON.stringify(args[1] === "user" ? { login: "me" } : []),
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
  writeState(root, "peers", { b: { time: now, leader: true, term: 1, kit: null, assigned: [{ repo: "o/r", issue: 7, epoch: 1 }] } });
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
  assert.equal(await nodeStatus(p.deps), "node=running leader=a peers=1/3\nload b cpu=- mem=- rtt=-");
  assert.deepEqual(await stopNode(p.deps), { stopped: true, already: false });
  assert.ok(p.signals.includes("SIGTERM"));
  assert.equal(existsSync(path.join(stateDir(root), "node.json")), false);
  assert.equal(readState(root, "queue").length, 1);
  assert.equal(readState(root, "outbox").length, 1);
  assert.equal(readState(root, "peers").b.leader, true);
  assert.equal(existsSync(path.join(stateDir(root), "node.log")), true);
  assert.deepEqual(await stopNode(p.deps), { stopped: true, already: true });
  assert.equal(await nodeStatus(p.deps), "node=stopped leader=b peers=1/3\nload b cpu=- mem=- rtt=-");
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
  assert.equal(await nodeStatus(p.deps), "node=stopped leader=b peers=1/3\nload b cpu=- mem=- rtt=-");
  writeState(root, "proposal", { id: "b", term: 2 });
  assert.match(await nodeStatus(p.deps), /proposed Leader b term 2: run npx architecture-harness fleet confirm-leader/);
});

test("serve schedules heartbeats every 30 seconds, retries every second and closes cleanly", async t => {
  const root = fixture(t);
  let time = now;
  const timers = [], signals = new Map(), sent = [], cleared = [];
  const server = await serveNode({ root, fleet, repo: "o/r", kit: null, leader: true, clock: () => time,
    gh: apiResponse, listen: { port: 0 }, pid: 12345, timer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
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
  assert.deepEqual(sent[0].body, { load: initialLoad, os: host, kit: null, term: 1, leader: true, work: [], assigned: [] });
  assert.equal(readState(root, "node").leader, true);
  const closed = new Promise(resolve => server.once("close", resolve));
  signals.get("SIGTERM")();
  await closed;
  assert.equal(cleared.length, 1);
  assert.equal(signals.size, 0);
  assert.equal(existsSync(path.join(stateDir(root), "node.json")), false);
});

test("serve advertises a hostname as its bound IPv4 to a receiver, refreshes the same fleet for HTTP, heartbeats and expiry, and closes discovery on shutdown", async t => {
  const { createBeacon, readDiscovered, startDiscovery } = await import("./fleet-discover.mjs");
  const order = getDefaultResultOrder();
  setDefaultResultOrder("ipv4first");
  t.after(() => setDefaultResultOrder(order));
  const root = fixture(t), signals = new Map(), sent = [], beacons = [];
  const current = { self: "a", secret, discover: true, nodes: [{ id: "a", address: "localhost", weight: 1, maxSize: "L", port: 8080 }], leaders: ["a"] };
  const { createHash } = await import("node:crypto");
  mkdirSync(stateDir(root), { recursive: true });
  writeFileSync(path.join(stateDir(root), "discovered.json"), JSON.stringify({
    fleet: createHash("sha256").update(`${secret}a`, "utf8").digest("hex").slice(0, 16),
    nodes: { stale: { address: "127.0.0.1", port: 9091, weight: 1, maxSize: "L", seen: now } },
  }));
  let time = now, tick, closed = false;
  const socket = new EventEmitter();
  socket.bind = (_port, _host, ready) => ready();
  socket.setBroadcast = () => {};
  socket.send = (data, _port, _address, callback) => { beacons.push(JSON.parse(data)); callback?.(); };
  socket.close = () => { closed = true; };
  const interfaces = () => ({ test: [{ address: "127.0.0.1", family: "IPv4", internal: false, netmask: "255.0.0.0" }] });
  const server = await serveNode({ root, fleet: current, repo: "o/r", clock: () => time, listen: { port: 0 },
    interfaces, discovery: { createSocket: () => socket, timer: () => 42, clearTimer() {} },
    gh: apiResponse, timer: fn => { tick = fn; }, clearTimer() {},
    onSignal: (name, fn) => signals.set(name, fn), offSignal: name => signals.delete(name),
    fetch: async (url, options) => { sent.push({ url, message: JSON.parse(options.body) }); return { status: 202 }; } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal(current.nodes[0].address, "localhost");
  assert.equal(server.address().address, "127.0.0.1");
  assert.ok(beacons.length > 0);
  assert.deepEqual(beacons[0].addresses, [server.address().address]);
  const receiverRoot = fixture(t), receiver = new EventEmitter();
  receiver.bind = (_port, _host, ready) => ready();
  receiver.setBroadcast = receiver.send = receiver.close = () => {};
  const discovery = await startDiscovery({ root: receiverRoot,
    fleet: { self: "b", secret, nodes: [{ id: "b", port: 9090 }] }, address: "127.0.0.1", interfaces,
    clock: () => time, createSocket: () => receiver, timer: () => 42, clearTimer() {} });
  t.after(() => discovery.close());
  receiver.emit("message", Buffer.from(JSON.stringify(beacons[0])), { address: server.address().address });
  assert.equal(readDiscovered(receiverRoot, secret).a.address, "127.0.0.1");
  assert.deepEqual(current.nodes.map(node => node.id), ["a"]);
  const remote = { self: "b", secret, nodes: [{ id: "b", address: "127.0.0.1", port: 9090, weight: 2, maxSize: "M" }] };
  socket.emit("message", Buffer.from(JSON.stringify(createBeacon({ fleet: remote, address: "127.0.0.1", clock: () => time }))), { address: "127.0.0.1" });
  time += 30_000;
  await tick();
  assert.deepEqual(current.leaders, ["a", "b"]);
  assert.equal(current.nodes.find(node => node.id === "b").port, 9090);
  assert.ok(sent.some(row => row.url === "http://127.0.0.1:9090/message" && row.message.kind === "heartbeat"));
  const body = createMessage({ from: "b", repo: "o/r", kind: "heartbeat", body: { term: 1, leader: false, kit: null }, time: new Date(time).toISOString() }, secret);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/message`, { method: "POST", body: JSON.stringify(body) });
  assert.equal(response.status, 202);
  time = now + 300_001;
  await tick();
  assert.deepEqual(current.nodes.map(node => node.id), ["a"]);
  assert.deepEqual(current.leaders, ["a"]);
  const stopped = once(server, "close");
  signals.get("SIGTERM")();
  await stopped;
  assert.equal(closed, true);
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
  const beats = Array.from({ length: 4 }, () => message({ kind: "heartbeat", body: { kit: null, term: 1, leader: false } }));
  for (const beat of beats) assert.equal((await post(beat)).status, 202);
  assert.deepEqual(readState(root, "queue"), [queued]);
  assert.deepEqual(readState(root, "peers"), { b: { time: now, messageTime: beats[0].time, kit: null, term: 1, leader: false } });
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
    gh: apiResponse, onSignal: (name, fn) => signals.set(name, fn), offSignal: name => signals.delete(name) });
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

test("node ticks consume only leader assignments, validate bodies, and keep the higher epoch", async t => {
  const root = fixture(t);
  let tick;
  writeState(root, "peers", { b: { time: now, leader: true, assigned: [{ repo: "o/r", issue: 7, epoch: 2 }] }, inactive: { time: now, leader: false } });
  const assign = (body, from = "b") => message({ kind: "assign", from, body });
  const other = message(), unclaimed = assign({ issue: 9, epoch: 1 }, "unaddressed");
  writeState(root, "queue", [other, assign({ issue: 7, epoch: 2 }), assign({ issue: 7, epoch: 1 }),
    assign({ issue: 7, epoch: 2 }), assign({ issue: 8, epoch: 1 }, "inactive"), unclaimed,
    ...[0, -1, 1.5, "3", null].flatMap(value => [assign({ issue: value, epoch: 1 }), assign({ issue: 8, epoch: value })])]);
  const server = await serveNode({ root, fleet, repo: "o/r", clock: () => now, listen: { port: 0 },
    gh: apiResponse, timer: fn => { tick = fn; }, clearTimer() {}, onSignal() {}, offSignal() {} });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await tick();
  assert.deepEqual(readState(root, "assignments"), { "o/r#7": { repo: "o/r", issue: 7, node: "a", epoch: 2, time: now } });
  assert.deepEqual(readState(root, "queue"), [other, unclaimed]);
  writeState(root, "peers", { b: { time: now, leader: true, assigned: [{ repo: "o/r", issue: 7, epoch: 3 }] } });
  writeState(root, "queue", [assign({ issue: 7, epoch: 3 })]);
  await tick();
  assert.equal(readState(root, "assignments")["o/r#7"].epoch, 3);
  writeState(root, "peers", { b: { time: now, leader: false } });
  writeState(root, "queue", [assign({ issue: 7, epoch: 4 })]);
  await tick();
  assert.equal(readState(root, "assignments")["o/r#7"].epoch, 3);
});

test("leader assigns every 60 seconds through gh, persists and sends; gh failure skips the whole tick", async t => {
  const root = fixture(t), calls = [], sent = [], warnings = [];
  let tick, time = now, fail = false;
  const nodes = { ...fleet, nodes: fleet.nodes.slice(0, 2).map(node => ({ ...node, weight: 1, maxSize: "L" })) };
  writeState(root, "peers", { b: { time: now, kit: "kit", term: 1, leader: false } });
  const server = await serveNode({ root, fleet: nodes, repo: "o/r", kit: "kit", term: 1, leader: true, clock: () => time, listen: { port: 0 },
    timer: fn => { tick = fn; }, clearTimer() {}, onSignal() {}, offSignal() {}, warn: text => warnings.push(text), git: () => "",
    gh: args => { if (args[0] === "api") return apiResponse(args); calls.push(args); if (fail && args.includes("number")) throw new Error("gh offline"); return JSON.stringify(args[0] === "pr" ? [] : args.includes("number,labels,createdAt")
      ? [1, 2].map(number => ({ number, labels: [], createdAt: "2026-01-01" })) : [1, 2, 99].map(number => ({ number }))); },
    fetch: async (_url, options) => { sent.push(JSON.parse(options.body)); return { status: 202 }; } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  time += 59_999; await tick(); assert.equal(calls.length, 0);
  time++; await tick();
  assert.equal(calls.length, 3);
  assert.ok(calls.every(args => args[1] === "list"));
  assert.ok(calls.some(args => args[0] === "issue" && args.includes("number") && args.includes("open")));
  assert.equal(Object.keys(readState(root, "assignments")).length, 2);
  const remote = Object.values(readState(root, "assignments")).find(row => row.node === "b");
  const outgoing = sent.filter(item => item.kind === "assign");
  assert.equal(outgoing.length, 1);
  assert.deepEqual(outgoing[0].body, { issue: remote.issue, epoch: 1 });
  assert.equal(verifyMessage(outgoing[0], { secret, nodes: nodes.nodes, seen: {}, now: time }).ok, true);
  const kept = { ...readState(root, "assignments"), "o/r#99": { repo: "o/r", issue: 99, node: "b", epoch: 1, time: now } };
  writeState(root, "assignments", kept);
  time += 60_000; fail = true;
  writeState(root, "peers", { ...readState(root, "peers"), b: { time, kit: "kit", term: 1, leader: false } });
  await tick();
  assert.deepEqual(readState(root, "assignments"), kept);
  assert.match(warnings.at(-1), /gh offline/);
  assert.ok(sent.some(row => row.kind === "heartbeat" && Date.parse(row.time) === time), "a failed issue read must not suppress the heartbeat");
  fail = false; time += 60_000;
  writeState(root, "peers", { ...readState(root, "peers"), b: { time, kit: "kit", term: 1, leader: false } });
  await tick();
  assert.deepEqual(readState(root, "assignments"), kept);
});

test("regression: follower clears closed assignments in every held repo and keeps them on gh errors", async t => {
  const root = fixture(t), calls = [], warnings = [];
  let tick, time = now, fail = true;
  const held = (repo, issue, node = "a") => ({ repo, issue, node, epoch: 1, time: now });
  writeState(root, "assignments", {
    "o/r#7": held("o/r", 7), "o/r#8": held("o/r", 8),
    "else/r#9": held("else/r", 9), "third/r#10": held("third/r", 10, "b"),
  });
  const server = await serveNode({ root, fleet, repo: "o/r", clock: () => time, listen: { port: 0 },
    timer: fn => { tick = fn; }, clearTimer() {}, onSignal() {}, offSignal() {}, warn: text => warnings.push(text),
    fetch: async () => ({ status: 202 }), gh: (args, options) => {
      if (args[0] === "api") return apiResponse(args);
      const repo = args.at(-1); calls.push(repo);
      assert.equal(options.cwd, root);
      assert.deepEqual(args, ["issue", "list", "--state", "open", "--limit", "500", "--json", "number", "--repo", repo]);
      if (repo === "else/r" && fail) throw new Error("gh offline");
      return JSON.stringify(repo === "o/r" ? [{ number: 8 }] : []);
    } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  time += 59_999; await tick(); assert.deepEqual(calls, []);
  time++; await tick();
  assert.deepEqual(calls, ["o/r", "else/r"]);
  assert.deepEqual(Object.keys(readState(root, "assignments")), ["o/r#8", "else/r#9", "third/r#10"]);
  assert.match(warnings.at(-1), /gh offline/);
  fail = false; time += 60_000;
  writeState(root, "peers", { ...readState(root, "peers"), b: { time, kit: "kit", term: 1, leader: false } });
  await tick();
  assert.deepEqual(Object.keys(readState(root, "assignments")), ["o/r#8", "third/r#10"]);
});

test("regression: leader queues every new assign before a stop during the first send", async t => {
  const root = fixture(t), signals = new Map();
  let tick, time = now, savedAtSend;
  const nodes = { ...fleet, nodes: ["a", "b", "c"].map((id, index) => ({ id, address: "127.0.0.1", port: 8080 + index, weight: 1, maxSize: "L" })) };
  writeState(root, "assignments", { "o/r#99": { repo: "o/r", issue: 99, node: "a", epoch: 1, time: now } });
  writeState(root, "peers", { b: { time: now, kit: null, term: 1, leader: false }, c: { time: now, kit: null, term: 1, leader: false } });
  const server = await serveNode({ root, fleet: nodes, repo: "o/r", leader: true, clock: () => time, listen: { port: 0 },
    timer: fn => { tick = fn; }, clearTimer() {}, onSignal: (name, fn) => signals.set(name, fn), offSignal() {}, git: () => "",
    gh: args => args[0] === "api" ? apiResponse(args) : JSON.stringify(args[0] === "pr" ? [] : args.includes("number") ? [1, 2, 99].map(number => ({ number }))
      : [1, 2].map(number => ({ number, labels: [], createdAt: "2026-01-01" }))),
    fetch: async (_url, options) => {
      if (JSON.parse(options.body).kind === "assign") {
        savedAtSend = readState(root, "outbox");
        signals.get("SIGTERM")();
      }
      return { status: 202 };
    } });
  t.after(() => { server.closeAllConnections(); server.close(); });
  time += 60_000; await tick();
  assert.equal(savedAtSend?.length, 2, "all remote assigns must be durable before the first send");
  assert.deepEqual(new Set(savedAtSend.map(entry => entry.node)), new Set(["b", "c"]));
  assert.ok(savedAtSend.every(entry => entry.message.kind === "assign" && !entry.message.sig && !entry.message.time));
  assert.deepEqual(readState(root, "outbox"), savedAtSend);
});

test("regression: assign waits for a Leader heartbeat, expires after ten minutes, or drops on denial", async t => {
  const root = fixture(t);
  let tick, time = now;
  const server = await serveNode({ root, fleet, repo: "o/r", clock: () => time, listen: { port: 0 },
    timer: fn => { tick = fn; }, clearTimer() {}, onSignal() {}, offSignal() {}, fetch: async () => ({ status: 202 }),
    gh: args => args[0] === "api" ? apiResponse(args) : JSON.stringify([{ number: 7 }]) });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = fields => fetch(`http://127.0.0.1:${server.address().port}/message`, { method: "POST",
    body: JSON.stringify(message({ ...fields, time: new Date(time).toISOString() })) });
  const pending = message({ kind: "assign", body: { issue: 7, epoch: 1 } });
  assert.equal((await post(pending)).status, 202);
  await tick();
  assert.deepEqual(readState(root, "queue"), [pending]);
  assert.deepEqual(readState(root, "assignments"), {});
  time += 599_999; await tick();
  assert.deepEqual(readState(root, "queue"), [pending]);
  assert.equal((await post({ kind: "heartbeat", body: { kit: null, term: 1, leader: true, assigned: [{ repo: "o/r", issue: 7, epoch: 1 }] } })).status, 202);
  await tick();
  assert.equal(readState(root, "assignments")["o/r#7"].epoch, 1);
  assert.deepEqual(readState(root, "queue"), []);
  writeState(root, "peers", {});
  const expired = message({ kind: "assign", body: { issue: 8, epoch: 1 }, time: new Date(time).toISOString() });
  writeState(root, "queue", [expired]);
  time += 600_000; await tick();
  assert.deepEqual(readState(root, "queue"), []);
  const denied = message({ kind: "assign", body: { issue: 9, epoch: 1 }, time: new Date(time).toISOString() });
  assert.equal((await post(denied)).status, 202);
  assert.equal((await post({ kind: "heartbeat", body: { kit: null, term: 1, leader: false } })).status, 202);
  await tick();
  assert.deepEqual(readState(root, "queue"), []);
  assert.deepEqual(Object.keys(readState(root, "assignments")), ["o/r#7"]);
});

test("regression: Leader resends a dropped unclaimed assign and skips an identical pending assign", async t => {
  const root = fixture(t), followerRoot = fixture(t), sent = [];
  let leaderTick, followerTick, time = now;
  const nodes = { ...fleet, nodes: fleet.nodes.slice(0, 2).map(node => ({ ...node, weight: 1, maxSize: "L" })) };
  const follower = await serveNode({ root: followerRoot, fleet: { ...nodes, self: "b" }, repo: "o/r", clock: () => time,
    listen: { port: 0 }, timer: fn => { followerTick = fn; }, clearTimer() {}, onSignal() {}, offSignal() {},
    fetch: async () => ({ status: 202 }), gh: args => args[0] === "api" ? apiResponse(args) : JSON.stringify([{ number: 7 }]) });
  t.after(() => new Promise(resolve => follower.close(resolve)));
  const held = { "o/r#7": { repo: "o/r", issue: 7, node: "b", epoch: 2, time: now } };
  writeState(root, "assignments", held);
  const initial = message({ from: "a", kind: "assign", body: { issue: 7, epoch: 2 } });
  writeState(followerRoot, "queue", [initial]);
  const leader = await serveNode({ root, fleet: nodes, repo: "o/r", leader: true, clock: () => time,
    listen: { port: 0 }, timer: fn => { leaderTick = fn; }, clearTimer() {}, onSignal() {}, offSignal() {}, git: () => "",
    gh: args => args[0] === "api" ? apiResponse(args) : JSON.stringify(args[0] === "pr" || args.includes("number,labels,createdAt") ? [] : [{ number: 7 }]),
    fetch: async (_url, options) => {
      sent.push(JSON.parse(options.body));
      return fetch(`http://127.0.0.1:${follower.address().port}/message`, options);
    } });
  t.after(() => new Promise(resolve => leader.close(resolve)));
  time += 600_000;
  await followerTick();
  assert.deepEqual(readState(followerRoot, "queue"), []);
  assert.deepEqual(readState(followerRoot, "assignments"), {});
  const live = () => writeState(root, "peers", { b: { time, kit: null, term: 1, leader: false } });
  live(); await leaderTick();
  assert.equal(readState(followerRoot, "queue").filter(row => row.kind === "assign").length, 1);
  await followerTick();
  const accepted = readState(followerRoot, "assignments");
  assert.deepEqual(accepted["o/r#7"], { ...held["o/r#7"], time });
  time += 60_000; live(); await leaderTick(); await followerTick();
  const repeats = sent.filter(row => row.kind === "assign");
  assert.equal(repeats.length, 2);
  assert.notEqual(repeats[0].id, repeats[1].id);
  assert.deepEqual(repeats.map(row => row.body), [{ issue: 7, epoch: 2 }, { issue: 7, epoch: 2 }]);
  assert.deepEqual(readState(followerRoot, "assignments"), accepted);
  const pending = { node: "b", attempts: 1, nextAttempt: time + 300_000, message: repeats[1] };
  writeState(root, "outbox", [pending]);
  time += 60_000; live(); await leaderTick();
  assert.deepEqual(readState(root, "outbox"), [pending]);
  assert.equal(sent.filter(row => row.kind === "assign").length, 2);
});

test("heartbeats carry own work, per-recipient Leader assignments, and replace peer snapshots", async t => {
  const root = fixture(t), received = [];
  const nodes = { ...fleet, nodes: [...fleet.nodes.slice(0, 2), { id: "c", address: "127.0.0.1", port: 8082 }] };
  const held = (issue, node, epoch = 1) => ({ repo: "o/r", issue, node, epoch, time: now });
  const work = { repo: "o/r", issue: 1, epoch: 1, step: "code", branch: "feat/1", head: "a".repeat(40) };
  writeState(root, "assignments", { "o/r#1": held(1, "a"), "o/r#2": held(2, "b"), "o/r#3": held(3, "c") });
  writeState(root, "work", { "o/r#1": work, "o/r#2": { ...work, issue: 2 }, "o/r#9": { ...work, issue: 9 } });
  const fetcher = async (_url, options) => { received.push(JSON.parse(options.body)); return { status: 202 }; };
  await heartbeat({ root, fleet: nodes, repo: "o/r", leader: true, clock: () => now, fetch: fetcher });
  assert.deepEqual(received.map(row => row.body), [
    { load: initialLoad, os: host, kit: null, term: 1, leader: true, work: [work], assigned: [{ repo: "o/r", issue: 2, epoch: 1 }] },
    { load: initialLoad, os: host, kit: null, term: 1, leader: true, work: [work], assigned: [{ repo: "o/r", issue: 3, epoch: 1 }] },
  ]);
  received.length = 0;
  writeState(root, "assignments", { "o/r#1": held(1, "a", 2) });
  await heartbeat({ root, fleet: nodes, repo: "o/r", clock: () => now, fetch: fetcher });
  assert.deepEqual(received[0].body, { load: { ...initialLoad, rtt: 0 }, os: host, kit: null, term: 1, leader: false, work: [{ repo: "o/r", issue: 1, epoch: 2, step: null, branch: null, head: null }] });
  const server = await createNodeServer({ root, fleet: nodes, clock: () => now, listen: { port: 0 } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  let sentTime = now;
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/message`, { method: "POST",
    body: JSON.stringify(message({ kind: "heartbeat", body, time: new Date(sentTime++).toISOString() })) });
  const body = { os: host, kit: null, term: 1, leader: true, work: [work], assigned: [{ repo: "o/r", issue: 1, epoch: 2 }] };
  assert.equal((await post(body)).status, 202);
  assert.deepEqual(readState(root, "peers").b, { time: now, messageTime: new Date(now).toISOString(), ...body });
  assert.equal((await post({ ...body, work: [], assigned: [] })).status, 202);
  assert.deepEqual(readState(root, "peers").b.work, []);
  for (const bad of [{ work: {} }, { assigned: {} }, { work: [{ ...work, head: "bad" }] }, { assigned: [{ repo: "o/r", issue: 1, epoch: 0 }] }]) {
    assert.equal((await post({ ...body, ...bad })).status, 400);
  }
  assert.deepEqual(readState(root, "peers").b.assigned, []);
});

test("follower keeps work before a Leader heartbeat, then drops missing and changed epochs from the latest Leader", async t => {
  const root = fixture(t);
  let tick;
  const held = (issue, node = "a", epoch = 1) => ({ repo: "o/r", issue, node, epoch, time: now });
  writeState(root, "assignments", { "o/r#1": held(1), "o/r#2": held(2), "o/r#3": held(3), "o/r#4": held(4, "b") });
  const server = await serveNode({ root, fleet, repo: "o/r", clock: () => now, listen: { port: 0 },
    timer: fn => { tick = fn; }, clearTimer() {}, onSignal() {}, offSignal() {} });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await tick();
  assert.equal(Object.keys(readState(root, "assignments")).length, 4);
  writeState(root, "peers", {
    b: { time: now - 1, leader: true, assigned: [{ repo: "o/r", issue: 2, epoch: 1 }] },
    inactive: { time: now, leader: true, assigned: [{ repo: "o/r", issue: 1, epoch: 1 }, { repo: "o/r", issue: 2, epoch: 2 }] },
  });
  await tick();
  assert.deepEqual(readState(root, "assignments"), { "o/r#1": held(1), "o/r#4": held(4, "b") });
  writeState(root, "queue", [message({ from: "inactive", kind: "assign", body: { issue: 3, epoch: 1 } })]);
  await tick();
  assert.equal(readState(root, "assignments")["o/r#3"], undefined, "an old queued assign cannot restore revoked ownership");
});

test("regression: an older Leader heartbeat cannot restore b after takeover by c at epoch 2", async t => {
  const root = fixture(t), followerRoot = fixture(t);
  let leaderTick, followerTick, time = now;
  const nodes = { ...fleet, nodes: ["a", "b", "c"].map((id, index) => ({ id, address: "127.0.0.1", port: 8080 + index, weight: 1, maxSize: "L" })) };
  const followerFleet = { ...nodes, self: "b" }, config = path.join(followerRoot, "fleet.json");
  writeFileSync(config, JSON.stringify(followerFleet));
  const owns = () => runFleet(["owns", "7"], { cwd: followerRoot, env: { QC_FLEET_FILE: config },
    origin: () => "o/r", say() {}, warn() {} });
  const follower = await serveNode({ root: followerRoot, fleet: followerFleet, repo: "o/r", clock: () => time,
    listen: { port: 0 }, timer: fn => { followerTick = fn; }, clearTimer() {}, onSignal() {}, offSignal() {},
    fetch: async () => ({ status: 202 }), gh: () => JSON.stringify([{ number: 7 }]) });
  t.after(() => new Promise(resolve => follower.close(resolve)));
  const post = envelope => fetch(`http://127.0.0.1:${follower.address().port}/message`, { method: "POST", body: JSON.stringify(envelope) });
  const oldBeat = message({ from: "a", kind: "heartbeat", body: { kit: null, term: 1, leader: true,
    assigned: [{ repo: "o/r", issue: 7, epoch: 1 }] } });
  const held = { repo: "o/r", issue: 7, node: "b", epoch: 1, time: now };
  writeState(followerRoot, "assignments", { "o/r#7": held });
  writeState(root, "assignments", { "o/r#7": held, "o/r#8": { ...held, issue: 8, node: "a" } });
  writeState(root, "peers", { b: { time: now - 30_000, kit: null }, c: { time: now, kit: null } });
  const leader = await serveNode({ root, fleet: nodes, repo: "o/r", leader: true, clock: () => time,
    listen: { port: 0 }, timer: fn => { leaderTick = fn; }, clearTimer() {}, onSignal() {}, offSignal() {}, git: () => "",
    gh: args => JSON.stringify(args.includes("number") ? [{ number: 7 }, { number: 8 }] : []),
    fetch: async (url, options) => url.includes(":8081/") ? post(JSON.parse(options.body)) : { status: 202 } });
  t.after(() => new Promise(resolve => leader.close(resolve)));
  time += 60_000;
  await leaderTick();
  assert.equal(readState(root, "assignments")["o/r#7"].node, "c");
  assert.equal(readState(root, "assignments")["o/r#7"].epoch, 2);
  time += 30_000;
  await leaderTick();
  assert.deepEqual(readState(followerRoot, "peers").a.assigned, []);
  assert.equal(owns(), 1, "revoked ownership fails immediately, before the next follower tick");
  await followerTick();
  assert.equal(readState(followerRoot, "assignments")["o/r#7"], undefined);
  time++;
  assert.equal((await post(oldBeat)).status, 202);
  assert.equal((await post(message({ from: "a", kind: "assign", body: { issue: 7, epoch: 1 } }))).status, 202);
  assert.equal(owns(), 1, "a delayed assign does not confer ownership before the tick");
  await followerTick();
  assert.equal(owns(), 1, "a delayed epoch 1 assign cannot restore ownership after the tick");
  assert.equal(readState(followerRoot, "assignments")["o/r#7"], undefined);
});

test("three-node takeover saves the dead node's branch and head on the new follower", async t => {
  const root = fixture(t), followerRoot = fixture(t), head = "b".repeat(40), branch = "feat/7-old";
  let leaderTick, followerTick, time = now;
  const nodes = { ...fleet, nodes: ["a", "b", "c"].map((id, index) => ({ id, address: "127.0.0.1", port: 8080 + index, weight: 1, maxSize: "L" })) };
  const follower = await serveNode({ root: followerRoot, fleet: { ...nodes, self: "c" }, repo: "o/r", clock: () => time,
    listen: { port: 0 }, timer: fn => { followerTick = fn; }, clearTimer() {}, onSignal() {}, offSignal() {}, fetch: async () => ({ status: 202 }) });
  t.after(() => new Promise(resolve => follower.close(resolve)));
  const row = (issue, node) => ({ repo: "o/r", issue, node, epoch: 1, time: now });
  writeState(root, "assignments", { "o/r#7": row(7, "b"), "o/r#8": row(8, "a") });
  writeState(root, "peers", { b: { time: now - 30_000, kit: null, work: [{ repo: "o/r", issue: 7, epoch: 1, step: "code", branch, head }] }, c: { time: now, kit: null } });
  const leader = await serveNode({ root, fleet: nodes, repo: "o/r", leader: true, clock: () => time,
    listen: { port: 0 }, timer: fn => { leaderTick = fn; }, clearTimer() {}, onSignal() {}, offSignal() {}, git: () => "",
    gh: args => JSON.stringify(args.includes("number") ? [{ number: 7 }, { number: 8 }] : []),
    fetch: async (url, options) => url.includes(":8082/")
      ? fetch(`http://127.0.0.1:${follower.address().port}/message`, options) : { status: 202 } });
  t.after(() => new Promise(resolve => leader.close(resolve)));
  time += 60_000;
  await leaderTick();
  await followerTick();
  // The next heartbeat confirms the updated assignment snapshot.
  time += 30_000;
  await leaderTick(); await followerTick();
  assert.deepEqual(readState(followerRoot, "assignments")["o/r#7"], { repo: "o/r", issue: 7, node: "c", epoch: 2, time: now + 60_000, branch, head });
  assert.equal(readState(root, "assignments")["o/r#7"].node, "c");
});

test("the Leader keeps its own heartbeat snapshot so its sessions can check owns", async t => {
  const root = fixture(t);
  writeState(root, "assignments", { "o/r#7": { repo: "o/r", issue: 7, node: "a", epoch: 2, time: now } });
  await heartbeat({ root, fleet, repo: "o/r", leader: true, clock: () => now, fetch: async () => ({ status: 202 }) });
  assert.deepEqual(readState(root, "peers").a.assigned, [{ repo: "o/r", issue: 7, epoch: 2 }]);
});

test("an assign ahead of its Leader heartbeat waits without deleting the confirmed epoch", async t => {
  const root = fixture(t);
  let tick;
  const held = { repo: "o/r", issue: 7, node: "a", epoch: 1, time: now };
  writeState(root, "assignments", { "o/r#7": held });
  writeState(root, "peers", { b: { time: now, leader: true, assigned: [{ repo: "o/r", issue: 7, epoch: 1 }] } });
  const pending = message({ kind: "assign", body: { issue: 7, epoch: 2, branch: "feat/7", head: "a".repeat(40) } });
  writeState(root, "queue", [pending]);
  const server = await serveNode({ root, fleet, repo: "o/r", clock: () => now, listen: { port: 0 },
    timer: fn => { tick = fn; }, clearTimer() {}, onSignal() {}, offSignal() {} });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await tick();
  assert.deepEqual(readState(root, "assignments"), { "o/r#7": held });
  assert.deepEqual(readState(root, "queue"), [pending]);
  writeState(root, "peers", { b: { time: now + 1, leader: true, assigned: [{ repo: "o/r", issue: 7, epoch: 2 }] } });
  await tick();
  assert.deepEqual(readState(root, "assignments")["o/r#7"], { ...held, epoch: 2, branch: "feat/7", head: "a".repeat(40) });
  assert.deepEqual(readState(root, "queue"), []);
});

test("Leader keeps plans and questions only for the assigned sender and epoch", async t => {
  const root = fixture(t);
  writeState(root, "assignments", { "o/r#7": { repo: "o/r", issue: 7, node: "b", epoch: 3 } });
  const valid = ["plan", "question"].map(kind => message({ kind, body: { issue: 7, epoch: 3, text: kind } }));
  writeState(root, "queue", [...valid,
    message({ kind: "plan", from: "a", body: { issue: 7, epoch: 3, text: "wrong sender" } }),
    message({ kind: "question", body: { issue: 7, epoch: 2, text: "old epoch" } }),
    message({ kind: "plan", repo: "other/repo", body: { issue: 7, epoch: 3, text: "wrong repo" } }),
    message({ kind: "plan", body: { issue: 7, epoch: 3, text: "x".repeat(20001) } })]);
  let tick;
  const server = await serveNode({ root, fleet, repo: "o/r", leader: true, clock: () => now, listen: { port: 0 },
    gh: apiResponse, timer: fn => { tick = fn; }, clearTimer() {}, onSignal() {}, offSignal() {} });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await tick();
  assert.deepEqual(readState(root, "queue"), valid);
});

test("follower records replies only from claimed Leaders at the held epoch, with assign claim expiry", async t => {
  const root = fixture(t);
  writeState(root, "assignments", { "o/r#7": { repo: "o/r", issue: 7, node: "a", epoch: 3 } });
  const approve = message({ kind: "approve", body: { issue: 7, epoch: 3, plan: "p1", approved: true, note: "Go" } });
  const answer = message({ kind: "answer", body: { issue: 7, epoch: 3, question: "q1", text: "Yes" } });
  const old = message({ kind: "answer", body: { issue: 7, epoch: 2, question: "old", text: "No" } });
  writeState(root, "queue", [approve, answer, old]);
  let tick;
  const server = await serveNode({ root, fleet, repo: "o/r", clock: () => now, listen: { port: 0 },
    gh: apiResponse, timer: fn => { tick = fn; }, clearTimer() {}, onSignal() {}, offSignal() {} });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await tick();
  assert.deepEqual(readState(root, "queue"), [approve, answer]);
  assert.deepEqual(readState(root, "inbox"), []);
  writeState(root, "peers", { b: { leader: true } });
  await tick();
  assert.deepEqual(readState(root, "plans"), { "o/r#7": approve });
  assert.deepEqual(readState(root, "answers"), { q1: answer });
  assert.deepEqual(readState(root, "inbox"), [approve, answer].map(({ id, kind, repo, body: { issue }, time }) => ({ id, kind, repo, issue, time })));
  assert.deepEqual(readState(root, "queue"), []);
  const rejected = [
    message({ ...approve, id: "not-leader", from: "inactive" }),
    message({ ...answer, id: "expired", from: "unaddressed", time: new Date(now - 600000).toISOString() }),
    message({ ...approve, id: "bad-body", body: { ...approve.body, approved: "yes" } }),
    message({ ...answer, id: "other-repo", repo: "x/y" }),
  ];
  writeState(root, "peers", { b: { leader: true }, inactive: { leader: false } });
  writeState(root, "queue", rejected);
  await tick();
  assert.deepEqual(readState(root, "queue"), []);
  assert.deepEqual(readState(root, "plans"), { "o/r#7": approve });
  assert.deepEqual(readState(root, "answers"), { q1: answer });
  assert.deepEqual(readState(root, "inbox"), [approve, answer].map(({ id, kind, repo, body: { issue }, time }) => ({ id, kind, repo, issue, time })));
});

function electionFleet(self, count = 3) {
  return { self, secret, leaders: ["a", "b", "c"].slice(0, count), nodes: ["a", "b", "c"].slice(0, count).map((id, i) =>
    ({ id, address: "127.0.0.1", port: 18080 + i, active: true, weight: 1, maxSize: "L" })) };
}
async function electionNode(t, self = "b", count = 3, extra = {}) {
  const cleanups = [], root = fixture({ after: fn => cleanups.push(fn) }), config = electionFleet(self, count), sent = [];
  let time = now, tick, server;
  const start = async () => {
    server = await serveNode({ root, fleet: config, repo: "o/r", clock: () => time, listen: { port: 0 },
      timer: fn => { tick = fn; }, clearTimer() {}, onSignal() {}, offSignal() {}, gh: args => args[0] === "api" ? apiResponse(args) : JSON.stringify([{ number: 7 }]),
      fetch: async (_url, options) => { sent.push(JSON.parse(options.body)); return { status: 202 }; }, ...extra });
  };
  await start();
  t.after(async () => { await new Promise(resolve => server.close(resolve)); for (const cleanup of cleanups) cleanup(); });
  return { root, config, sent, get server() { return server; }, tick: () => tick(), time: value => { time = value; },
    restart: async () => { await new Promise(resolve => server.close(resolve)); await start(); } };
}

test("three nodes propose in leaders order at 90 seconds, save after one live accept, and retain follower work", async t => {
  const f = await electionNode(t), held = { repo: "o/r", issue: 7, node: "b", epoch: 3, time: now };
  writeState(f.root, "assignments", { "o/r#7": held });
  writeState(f.root, "peers", { a: { leader: true, term: 1, time: now, assigned: [{ repo: "o/r", issue: 7, epoch: 3 }] }, c: { leader: false, term: 1, time: now + 89_999 } });
  f.time(now + 89_999); await f.tick();
  assert.equal(f.sent.filter(m => m.kind === "propose-leader").length, 0);
  f.time(now + 90_000); await f.tick();
  assert.deepEqual(f.sent.filter(m => m.kind === "propose-leader").map(m => [m.from, m.body]), [["b", { term: 2 }]]);
  assert.deepEqual(readState(f.root, "proposal"), {});
  assert.deepEqual(readState(f.root, "assignments"), { "o/r#7": held });
  writeState(f.root, "queue", [message({ from: "a", kind: "leader", body: { term: 2, accept: true } })]);
  await f.tick(); assert.deepEqual(readState(f.root, "proposal"), {}, "dead peer cannot accept");
  writeState(f.root, "queue", [message({ from: "c", kind: "leader", body: { term: 2, accept: true } })]);
  await f.tick(); assert.deepEqual(readState(f.root, "proposal"), { id: "b", term: 2 });
  await f.tick(); assert.equal(f.sent.filter(m => m.kind === "propose-leader").length, 1);
  const later = await electionNode(t, "c");
  writeState(later.root, "peers", { a: { leader: true, term: 1, time: now }, b: { leader: false, term: 1, time: now + 90_000 } });
  later.time(now + 90_000); await later.tick();
  assert.equal(later.sent.filter(m => m.kind === "propose-leader").length, 0);
});

test("votes require a dead Leader and go once per term, including after a restart", async t => {
  const f = await electionNode(t, "c");
  const peers = { a: { leader: true, term: 1, time: now }, b: { leader: false, term: 1, time: now + 90_000 } };
  writeState(f.root, "peers", peers);
  const propose = term => message({ kind: "propose-leader", body: { term } });
  writeState(f.root, "queue", [propose(2)]); await f.tick();
  assert.equal(f.sent.filter(m => m.kind === "leader").length, 0);
  f.time(now + 90_000); writeState(f.root, "queue", [propose(2), propose(2), propose(1), propose(0), propose(2.5)]); await f.tick();
  assert.deepEqual(f.sent.filter(m => m.kind === "leader").map(m => m.body), [{ term: 2, accept: true }]);
  await f.restart();
  writeState(f.root, "queue", [propose(2)]); await f.tick();
  assert.equal(f.sent.filter(m => m.kind === "leader").length, 1);
  writeState(f.root, "queue", [propose(3)]); await f.tick();
  assert.deepEqual(f.sent.filter(m => m.kind === "leader").map(m => m.body), [{ term: 2, accept: true }, { term: 3, accept: true }]);
});

test("heartbeat terms fence old Leaders and malformed terms; a higher-term Leader stops duties", { timeout: 5000 }, async t => {
  const warnings = [];
  const f = await electionNode(t, "b", 3, { leader: true, gh: () => { throw new Error("stepped down Leader assigned"); }, warn: text => warnings.push(text) });
  await heartbeat({ root: f.root, fleet: f.config, repo: "o/r", leader: true, clock: () => now, fetch: async (_url, options) => {
    assert.equal(JSON.parse(options.body).body.term, 1); return { status: 202 };
  } });
  const post = (from, term, offset = 0) => fetch(`http://127.0.0.1:${f.server.address().port}/message`, { method: "POST", body: JSON.stringify(message({ from,
    kind: "heartbeat", time: new Date(now + offset).toISOString(), body: { leader: true, kit: null, ...(term === undefined ? {} : { term }), work: [], assigned: [] } })) });
  for (const term of [0, -1, 1.5, "2", null, undefined]) assert.equal((await post("c", term)).status, 400);
  assert.equal((await post("c", 3)).status, 202);
  assert.equal((await post("a", 2, 1)).status, 202);
  assert.equal(readState(f.root, "peers").a.leader, false);
  f.time(now + 60_000); await f.tick();
  assert.equal(readState(f.root, "node").leader, false);
  assert.ok(f.sent.filter(m => m.kind === "heartbeat").every(m => m.body.leader === false && m.body.term === 3));
  assert.equal((await post("a", 3, 2)).status, 202);
  assert.equal(readState(f.root, "peers").a.leader, true, "equal-term claim is accepted");
  assert.deepEqual(warnings, [], "a swallowed gh error must fail this test");
});

test("promotion during the heartbeat send to A gives C the rebuilt assignment at epoch 3", async t => {
  const root = fixture(t), config = electionFleet("b"), sent = [];
  const held = { repo: "o/r", issue: 7, epoch: 3, step: "code", branch: "feat/7", head: "a".repeat(40) };
  writeState(root, "node", { leader: false, term: 1 });
  writeState(root, "election", { highest: 2, started: now - 90_000 });
  writeState(root, "proposal", { id: "b", term: 2 });
  writeState(root, "peers", {
    a: { leader: true, term: 1, time: now - 90_000 },
    c: { leader: false, term: 1, time: now, work: [held] },
  });
  const { confirmLeader } = await import("./fleet-node.mjs");
  await heartbeat({ root, fleet: config, repo: "o/r", clock: () => now, fetch: async (url, options) => {
    const outgoing = JSON.parse(options.body);
    sent.push({ url, body: outgoing.body });
    if (sent.length === 1) {
      assert.equal(url, "http://127.0.0.1:18080/message");
      assert.equal(outgoing.body.leader, false);
      assert.equal(outgoing.body.term, 2);
      assert.equal(Object.hasOwn(outgoing.body, "assigned"), false);
      assert.equal(confirmLeader({ root, fleet: config, clock: () => now }), 2);
    }
    return { status: 202 };
  } });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].url, "http://127.0.0.1:18082/message");
  assert.deepEqual(sent[1].body, { load: initialLoad, os: host, kit: null, leader: true, term: 2, work: [],
    assigned: [{ repo: "o/r", issue: 7, epoch: 3 }] });
});

test("outbox fallback comments use the fresh role passed to authorization", async t => {
  for (const retry of [false, true]) await t.test(retry ? "after HTTP retry" : "direct fallback", async t => {
    const root = fixture(t), comments = [], roles = [];
    writeState(root, "node", { leader: retry, term: 1 });
    writeState(root, "peers", { b: { time: now } });
    writeState(root, "outbox", [{ node: "b", attempts: retry ? 2 : 3, nextAttempt: now,
      message: message({ from: "a", body: { issue: 7, epoch: 1 } }) }]);
    await flushOutbox({ root, fleet, clock: () => now, leader: true,
      allow: (_message, role) => { roles.push(role); return true; },
      fetch: async () => { writeState(root, "node", { leader: false, term: 2 }); return { status: 503 }; },
      gh: args => { comments.push(args); return ""; } });
    assert.equal(comments.length, 1);
    assert.match(comments[0][comments[0].indexOf("--body") + 1], /role=coder/);
    assert.deepEqual(roles.at(-1), { leader: false, term: retry ? 2 : 1 });
    assert.deepEqual(readState(root, "outbox"), []);
  });
});

test("demotion during an assign retry with attempts=2 fences the GitHub fallback after a 503", async t => {
  let f, retries = 0;
  const comments = [], warnings = [];
  f = await electionNode(t, "a", 3, { leader: true, warn: text => warnings.push(text),
    gh: args => {
      if (args[0] === "api") return apiResponse(args);
      comments.push(args);
      return "";
    },
    fetch: async (_url, options) => {
      if (JSON.parse(options.body).kind !== "assign") return { status: 202 };
      retries++;
      const response = await fetch(`http://127.0.0.1:${f.server.address().port}/message`, { method: "POST",
        body: JSON.stringify(message({ from: "b", kind: "heartbeat",
          body: { leader: true, term: 2, kit: null, assigned: [], work: [] } })) });
      assert.equal(response.status, 202);
      assert.equal(readState(f.root, "node").leader, false);
      return { status: 503 };
    } });
  writeState(f.root, "peers", { c: { leader: false, term: 1, time: now } });
  const assignment = message({ from: "a", kind: "assign", body: { issue: 7, epoch: 1 } });
  writeState(f.root, "outbox", [{ node: "c", attempts: 2, nextAttempt: now, message: assignment }]);
  await f.tick();
  assert.equal(retries, 1);
  assert.deepEqual(comments, [], "a demoted Leader must not post the assignment to GitHub");
  assert.deepEqual(readState(f.root, "outbox"), []);
  assert.deepEqual(readState(f.root, "dead").map(entry => [entry.message.id, entry.reason]), [[assignment.id, "not leader"]]);
  assert.deepEqual(warnings, []);
});

test("demotion during an awaited send fences the next assignment, Leader send and retry", async t => {
  for (const phase of ["retry", "assignment", "heartbeat"]) await t.test(phase, async t => {
    let f, demoted = false, readsAfterDemotion = 0;
    const sent = [], warnings = [];
    f = await electionNode(t, "a", 3, { leader: true, git: () => "", warn: text => warnings.push(text),
      gh: args => { if (args[0] === "api") return apiResponse(args); if (demoted) readsAfterDemotion++; return JSON.stringify(args.includes("number") ? [{ number: 7 }, { number: 8 }] : []); },
      fetch: async (_url, options) => {
        const outgoing = JSON.parse(options.body);
        sent.push(outgoing);
        if (!demoted && outgoing.kind === (phase === "retry" ? "question" : phase === "assignment" ? "assign" : "heartbeat")) {
          const response = await fetch(`http://127.0.0.1:${f.server.address().port}/message`, { method: "POST",
            body: JSON.stringify(message({ from: "b", kind: "heartbeat", time: new Date(now + 60_000).toISOString(),
              body: { leader: true, term: 2, kit: null, assigned: [], work: [] } })) });
          assert.equal(response.status, 202);
          assert.equal(readState(f.root, "node").leader, false);
          demoted = true;
        }
        return { status: 202 };
      } });
    writeState(f.root, "peers", Object.fromEntries(["b", "c"].map(id => [id, { leader: false, term: 1, kit: null, time: now }])));
    if (phase === "retry") writeState(f.root, "outbox", ["question", "assign", "approve", "answer"].map((kind, i) => ({
      node: "c", attempts: 0, nextAttempt: now, message: message({ from: "a", kind, body: { issue: i + 1, epoch: 1 } }) })));
    if (phase === "assignment") writeState(f.root, "assignments", Object.fromEntries(["b", "c"].map((node, i) =>
      [`o/r#${i + 7}`, { repo: "o/r", issue: i + 7, node, epoch: 1, time: now, size: "M" }])));
    f.time(now + (phase === "heartbeat" ? 30_000 : 60_000));
    await f.tick();
    assert.equal(demoted, true, "the heartbeat must arrive during the send");
    assert.equal(readsAfterDemotion, 0, "the assignment tick must reread the role after the outbox await");
    const remaining = sent.slice(1);
    assert.ok(remaining.every(m => !["assign", "approve", "answer"].includes(m.kind)), "no Leader send or retry after demotion");
    assert.ok(remaining.filter(m => m.kind === "heartbeat").every(m => m.body.leader === false && m.body.term === 2),
      "each heartbeat send must reread the saved role and term");
    assert.deepEqual(warnings, []);
  });
});

test("a higher-term follower heartbeat fences an isolated old Leader after another Leader confirms", async t => {
  let reads = 0;
  const warnings = [], a = await electionNode(t, "a", 3, { leader: true, gh: args => { if (args[0] === "api") return apiResponse(args); reads++; return "[]"; }, git: () => "", warn: text => warnings.push(text) });
  const b = await electionNode(t, "b", 3);
  writeState(b.root, "peers", { a: { leader: true, term: 1, time: now }, c: { leader: false, term: 1, time: now + 90_000 } });
  b.time(now + 90_000); await b.tick();
  assert.ok(b.sent.some(m => m.kind === "propose-leader" && m.body.term === 2));
  writeState(b.root, "queue", [message({ from: "c", kind: "leader", body: { term: 2, accept: true } })]);
  await b.tick();
  const { confirmLeader } = await import("./fleet-node.mjs");
  assert.equal(confirmLeader({ root: b.root, fleet: b.config, clock: () => now + 90_000 }), 2);
  a.time(now + 120_000); await a.tick();
  assert.equal(reads, 0, "the isolated old Leader pauses");
  a.sent.length = 0;
  a.time(now + 180_000);
  const response = await fetch(`http://127.0.0.1:${a.server.address().port}/message`, { method: "POST", body: JSON.stringify(message({
    from: "c", kind: "heartbeat", time: new Date(now + 180_000).toISOString(), body: { leader: false, term: 2, kit: null, work: [] } })) });
  assert.equal(response.status, 202);
  const record = readState(a.root, "node");
  assert.deepEqual({ leader: record.leader, term: record.term }, { leader: false, term: 2 }, "a follower's higher term must persist demotion immediately");
  await a.tick();
  assert.equal(reads, 0, "reconnecting only to the follower must not resume assignments");
  assert.equal(readState(b.root, "node").leader, true);
  assert.equal(readState(b.root, "node").term, 2);
  const beats = a.sent.filter(m => m.kind === "heartbeat");
  assert.equal(beats.length, 2);
  assert.ok(beats.every(m => m.body.leader === false && m.body.term === readState(a.root, "election").highest),
    "follower heartbeats carry the highest term, including a new proposal after demotion");
  assert.deepEqual(warnings, []);
});

test("Leader stops assignment after 90 seconds without a peer and resumes when one returns", async t => {
  let reads = 0;
  const f = await electionNode(t, "b", 3, { leader: true, gh: args => { reads++; return "[]"; }, git: () => "" });
  f.time(now + 60_000); await f.tick(); assert.ok(reads > 0);
  reads = 0; f.time(now + 120_000); await f.tick(); assert.equal(reads, 0);
  writeState(f.root, "peers", { c: { leader: false, term: 1, time: now + 180_000 } });
  f.time(now + 180_000); await f.tick(); assert.ok(reads > 0);
});

test("partition grace starts at the last peer receipt and dead-letters refused assignment retries", async t => {
  let reads = 0;
  const f = await electionNode(t, "b", 3, { leader: true, gh: args => { if (args[0] === "api") return apiResponse(args); reads++; return "[]"; }, git: () => "" });
  writeState(f.root, "peers", { c: { leader: false, term: 1, time: now } });
  f.time(now + 60_000); await f.tick();
  reads = 0;
  const pending = { node: "c", attempts: 1, nextAttempt: now + 120_000, message: message({ from: "b", kind: "assign", body: { issue: 7, epoch: 1 } }) };
  writeState(f.root, "outbox", [pending]);
  f.time(now + 120_000); await f.tick();
  assert.equal(reads, 0);
  assert.equal(f.sent.filter(m => m.kind === "assign").length, 0);
  assert.deepEqual(readState(f.root, "outbox"), []);
  assert.deepEqual(readState(f.root, "dead"), [{ ...pending, reason: "not leader" }]);
});

test("serve follows confirmation in node.json on its next tick", async t => {
  const f = await electionNode(t, "b", 2, { gh: () => "[]", git: () => "" });
  f.time(now + 90_000); await f.tick();
  assert.equal(f.sent.filter(m => m.kind === "propose-leader").length, 0);
  const { confirmLeader } = await import("./fleet-node.mjs");
  assert.equal(confirmLeader({ root: f.root, fleet: f.config, clock: () => now + 90_000 }), 2);
  f.time(now + 120_000); await f.tick();
  assert.ok(f.sent.some(m => m.kind === "heartbeat" && m.body.leader === true && m.body.term === 2));
});

test("a higher-term heartbeat replaces an older-term snapshot despite signed-time order", async t => {
  const f = await electionNode(t);
  const post = (term, sent) => fetch(`http://127.0.0.1:${f.server.address().port}/message`, { method: "POST", body: JSON.stringify(message({ from: "c", kind: "heartbeat",
    time: new Date(sent).toISOString(), body: { kit: null, leader: true, term, assigned: [] } })) });
  assert.equal((await post(1, now + 1)).status, 202);
  assert.equal((await post(3, now)).status, 202);
  assert.equal(readState(f.root, "peers").c.term, 3);
  assert.equal(readState(f.root, "peers").c.leader, true);
  assert.equal((await post(1, now + 2)).status, 202);
  assert.equal(readState(f.root, "peers").c.term, 3, "a lower term must not replace the accepted snapshot");
});

test("persisted highest term fences queued assignments from an older Leader", async t => {
  const f = await electionNode(t);
  writeState(f.root, "election", { highest: 3, started: now });
  writeState(f.root, "peers", { a: { leader: true, term: 1, time: now, assigned: [{ repo: "o/r", issue: 7, epoch: 9 }] } });
  writeState(f.root, "queue", [message({ from: "a", kind: "assign", body: { issue: 7, epoch: 9 } })]);
  await f.tick();
  assert.deepEqual(readState(f.root, "assignments"), {});
});

test("an unassigned follower discovers its first GitHub assign while HTTP is unavailable", async t => {
  const root = fixture(t), calls = [], warnings = [];
  let tick;
  writeState(root, "peers", { b: { time: now, leader: true, term: 1, kit: null, assigned: [{ repo: "o/r", issue: 7, epoch: 1 }] } });
  const incoming = message({ kind: "assign", body: { issue: 7, epoch: 1 } });
  const { roleComment } = await import("./role-line.mjs");
  const body = roleComment({ role: "leader", node: "b", kind: "assign", ref: "#7", summary: "assign for #7",
    body: `<!-- qc:msg to=a ${Buffer.from(JSON.stringify(incoming)).toString("base64url")} -->` }, { secret });
  const server = await serveNode({ root, fleet, repo: "o/r", clock: () => now, listen: { port: 0 },
    timer: fn => { tick = fn; }, clearTimer() {}, onSignal() {}, offSignal() {}, warn: value => warnings.push(value),
    fetch: async () => { throw new Error("HTTP unavailable"); }, gh: args => {
      calls.push(args);
      return JSON.stringify(args[1] === "user" ? { login: "me" } : [{ user: { login: "me" }, body,
        issue_url: "https://api.github.com/repos/o/r/issues/7", updated_at: new Date(now).toISOString() }]);
    } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.deepEqual(readState(root, "assignments"), {});
  await tick();
  assert.deepEqual(readState(root, "assignments"), { "o/r#7": { repo: "o/r", issue: 7, node: "a", epoch: 1, time: now } });
  assert.deepEqual(calls, [["api", "user"], ["api", "--paginate",
    `repos/o/r/issues/comments?per_page=100&since=${new Date(now - 600_000).toISOString()}`]]);
  assert.deepEqual(readState(root, "queue"), []);
  assert.deepEqual(warnings, []);
});

test("node ticks poll GitHub every 120 seconds and receive authenticated work through the shared queue", async t => {
  const root = fixture(t), calls = [];
  let tick, time = now;
  writeState(root, "assignments", { "o/r#7": { repo: "o/r", issue: 7, node: "a", epoch: 1 } });
  const { roleComment } = await import("./role-line.mjs");
  const incoming = message({ kind: "verdict", body: { issue: 7 } });
  const body = roleComment({ role: "coder", node: "b", kind: "verdict", ref: "#7", summary: "verdict for #7",
    body: `<!-- qc:msg to=a ${Buffer.from(JSON.stringify(incoming)).toString("base64url")} -->` }, { secret });
  const server = await serveNode({ root, fleet, repo: "o/r", clock: () => time, listen: { port: 0 },
    timer: fn => { tick = fn; }, clearTimer() {}, onSignal() {}, offSignal() {}, fetch: async () => ({ status: 202 }),
    gh: args => {
      if (args[0] !== "api") return JSON.stringify([{ number: 7 }]);
      calls.push(args);
      return JSON.stringify(args[1] === "user" ? { login: "me" } : [{ user: { login: "me" }, body,
        issue_url: "https://api.github.com/repos/o/r/issues/7", updated_at: new Date(now).toISOString() }]);
    } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await tick();
  assert.equal(calls.length, 2);
  assert.deepEqual(readState(root, "queue"), [incoming]);
  time += 119_999; await tick(); assert.equal(calls.length, 2);
  time++; await tick(); assert.equal(calls.length, 4);
  assert.deepEqual(readState(root, "queue"), [incoming], "repeat GitHub reads cannot replay a message");
});

test("node tick supplies the Leader role to GitHub fallback and keeps polling after read failures", async t => {
  const root = fixture(t), posts = [], warnings = [];
  let tick, time = now, reads = 0;
  writeState(root, "assignments", { "o/r#7": { repo: "o/r", issue: 7, node: "b", epoch: 1 } });
  writeState(root, "outbox", [{ node: "b", message: message({ from: "a", body: { issue: 7 } }), attempts: 3, nextAttempt: now + 60_000 }]);
  const server = await serveNode({ root, fleet, repo: "o/r", leader: true, clock: () => time, listen: { port: 0 },
    timer: fn => { tick = fn; }, clearTimer() {}, onSignal() {}, offSignal() {}, warn: value => warnings.push(value),
    fetch: async () => ({ status: 202 }), gh: args => {
      if (args[0] === "api") { reads++; throw new Error("offline"); }
      if (args[1] === "comment") { posts.push(args[6]); return "posted"; }
      return "[]";
    }, git: () => "" });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await tick();
  assert.equal(posts.length, 1);
  assert.match(posts[0], /^\*\*Leader\*\*/);
  assert.deepEqual(readState(root, "outbox"), []);
  assert.deepEqual(readState(root, "github"), {});
  assert.equal(reads, 1);
  time += 120_000; await tick();
  assert.equal(reads, 2);
});


test("platform child checks leave serve ticks free to heartbeat and retain the peer OS", async t => {
  const root = fixture(t), sent = [];
  let tick, time = now, release, started;
  const waiting = new Promise(resolve => { release = resolve; });
  const running = new Promise(resolve => { started = resolve; });
  writeState(root, "peers", { b: { time, term: 1, leader: true, os: "windows" } });
  const server = await serveNode({ root, fleet, repo: "o/r", clock: () => time, listen: { port: 0 },
    timer: fn => { tick = fn; }, clearTimer() {}, onSignal() {}, offSignal() {}, gh: apiResponse,
    fetch: async (_url, options) => { sent.push(JSON.parse(options.body)); return { status: 202 }; },
    platform: { git: async () => {}, check: async () => { started(); await waiting; return { ok: true, tail: "done" }; } } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const incoming = message({ kind: "platform-check", body: { issue: 7, epoch: 1, branch: "feat/7", head: "a".repeat(40), pusher: "b" } });
  await fetch(`http://127.0.0.1:${server.address().port}/message`, { method: "POST", body: JSON.stringify(incoming) });
  await tick();
  // If serve does not dispatch to the injected runner this assertion fails without hanging.
  await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error("platform runner not started")), 1000))]);
  time += 30_000;
  await tick();
  assert.equal(sent.filter(row => row.kind === "heartbeat").length, 1);
  assert.equal(sent.filter(row => row.kind === "platform-result").length, 0);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.filter(row => row.kind === "platform-result").length, 1);
  const beat = message({ kind: "heartbeat", time: new Date(time).toISOString(), body: { kit: null, term: 1, leader: true, os: "windows" } });
  await fetch(`http://127.0.0.1:${server.address().port}/message`, { method: "POST", body: JSON.stringify(beat) });
  assert.equal(readState(root, "peers").b.os, "windows");
});

test("heartbeat samples fake OS and publishes the successful prior round median, including Leader load", async t => {
  const root = fixture(t);
  let time = now, busy = 10;
  const fakeOS = { cpus: () => [{ times: { user: busy, idle: 90 } }], freemem: () => 20, totalmem: () => 100 };
  const nodes = { ...fleet, nodes: [fleet.nodes[0], ...["b", "c", "d", "e", "f"].map(id => ({ id, address: "localhost" }))] };
  const received = [];
  let index = 0;
  const durations = [10, 30, 900, 20, 40];
  const deps = { root, fleet: nodes, repo: "o/r", leader: true, os: fakeOS, clock: () => time,
    fetch: async (_url, options) => { received.push(JSON.parse(options.body).body.load); time += durations[index % 5]; return { status: index++ % 5 === 2 ? 503 : 202 }; } };
  await heartbeat(deps);
  assert.deepEqual(received, Array(5).fill({ cpu: null, mem: 0.8, rtt: null }));
  assert.deepEqual(readState(root, "peers").a.load, { cpu: null, mem: 0.8, rtt: 25 });
  received.length = 0;
  busy = 110;
  await heartbeat(deps);
  assert.deepEqual(received, Array(5).fill({ cpu: 1, mem: 0.8, rtt: 25 }));
  await heartbeat({ ...deps, fetch: async () => { time += 50; return { status: 503 }; } });
  assert.equal(readState(root, "peers").a.load.rtt, null);
  received.length = 0;
  await heartbeat(deps);
  assert.equal(received[0].rtt, null);
});

test("status prints recent peer load with null markers and overload reasons", async t => {
  const root = fixture(t);
  const nodes = { ...fleet, nodes: [...fleet.nodes, { id: "c" }] };
  writeState(root, "peers", { b: { time: now, load: { cpu: 0.95, mem: 0.5, rtt: 2000 } },
    c: { time: now - 90000 }, inactive: { time: now - 90001 }, unaddressed: { time: now + 1 } });
  assert.equal(await nodeStatus({ root, fleet: nodes, clock: () => now }),
    "node=stopped leader=unknown peers=2/4\nload b cpu=95% mem=50% rtt=2000ms overloaded\nload c cpu=- mem=- rtt=-");
});

test("join mode exposes health and pair only, enforces 2 KB and sender validation", async t => {
  const { createKey } = await import("./fleet-pair.mjs");
  const root = fixture(t), joining = { ...fleet, secret: undefined, discover: true, key: createKey() };
  const server = await createNodeServer({ root, fleet: joining, clock: () => now, listen: { port: 0 } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/message`, { method: "POST", body: JSON.stringify(message()) })).status, 404);
  assert.equal((await fetch(`${base}/pair`, { method: "GET" })).status, 404);
  assert.equal((await fetch(`${base}/pair`, { method: "POST", body: "x".repeat(2049) })).status, 413);
  const body = { kind: "offer", leader: "leader", pub: createKey().public, port: 8080, time: now };
  assert.equal((await fetch(`${base}/pair`, { method: "POST", body: JSON.stringify(body) })).status, 202);
  assert.equal((await fetch(`${base}/pair`, { method: "POST", body: JSON.stringify({ ...body, address: "192.168.1.1" }) })).status, 400);
});

test("serve rereads the fleet file and leaves join mode on a tick without restarting", async t => {
  const { createKey, createPairing, pairCode, pairingDecision } = await import("./fleet-pair.mjs");
  const root = fixture(t), leaderRoot = fixture(t), ticks = [], beacons = [];
  const file = path.join(root, "fleet.json");
  const joining = { self: "joiner", discover: true, key: createKey(), nodes: [{ id: "joiner", address: "127.0.0.1", port: 8080, weight: 1 }] };
  const leading = { self: "leader", secret, key: createKey(), nodes: [{ id: "leader", port: 8081 }] };
  writeFileSync(file, JSON.stringify(joining));
  let githubReads = 0;
  class Socket extends EventEmitter {
    bind(_port, _address, fn) { fn(); }
    setBroadcast() {}
    send(data, _port, _address, fn) { beacons.push(JSON.parse(data)); fn(); }
    close() {}
  }
  const server = await serveNode({ root, fleet: joining, repo: "o/r", env: { QC_FLEET_FILE: file }, clock: () => now,
    listen: { port: 0 }, timer: fn => { ticks.push(fn); return 1; }, clearTimer: () => {},
    onSignal: () => {}, offSignal: () => {}, gh: args => { githubReads++; return apiResponse(args); },
    discovery: { createSocket: () => new Socket(), timer: () => 2, clearTimer: () => {} } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await ticks[0]();
  assert.equal(githubReads, 0);
  assert.equal(beacons[0].kind, "join");
  const sent = [];
  const pairing = createPairing({ root: leaderRoot, fleet: leading, address: "127.0.0.1", leader: () => true, clock: () => now,
    fetch: async (_url, options) => { sent.push(JSON.parse(options.body)); return { status: 202 }; } });
  pairing.receiveJoin(beacons[0], "127.0.0.1");
  await pairing.tick();
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/pair`, { method: "POST", body: JSON.stringify(sent[0]) })).status, 202);
  const code = pairCode(joining.key.public, leading.key.public);
  pairingDecision(leaderRoot, "allow", code, now);
  await pairing.tick();
  assert.equal((await fetch(`${base}/pair`, { method: "POST", body: JSON.stringify(sent.find(body => body.kind === "grant")) })).status, 202);
  await ticks[0]();
  assert.equal(JSON.parse(readFileSync(file, "utf8")).secret, undefined);
  pairingDecision(root, "accept", code, now);
  await ticks[0]();
  assert.equal(JSON.parse(readFileSync(file, "utf8")).secret, secret);
  assert.ok(githubReads > 0);
  assert.equal((await fetch(`${base}/message`, { method: "POST", body: "{}" })).status, 400);
});
