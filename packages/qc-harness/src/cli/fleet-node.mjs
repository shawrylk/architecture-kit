import { randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import { spawn as spawnProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";
import { createMessage, verifyMessage } from "./fleet-message.mjs";
import { pruneSeen, readState, stateDir, writeState } from "./fleet-state.mjs";

const LIMIT = 64 * 1024;
const endpoint = node => `http://${node.address.includes(":") ? `[${node.address}]` : node.address}:${node.port ?? 8080}`;

/** Small node:http transport with a fetch-shaped injection point. */
export function nodeFetch(url, { method = "GET", body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, signal, headers: body === undefined ? {} : { "content-type": "application/json" } }, res => {
      const chunks = [];
      let size = 0;
      res.on("data", chunk => {
        size += chunk.length;
        if (size > LIMIT) res.destroy(new Error("response too large"));
        else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, json: async () => JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** Bind only the configured local address; tests can request an OS-assigned port. */
export async function createNodeServer({ root = process.cwd(), fleet, clock = Date.now, listen = {}, instance = randomUUID() }) {
  const self = fleet.nodes.find(node => node.id === fleet.self);
  if (!fleet.secret) throw new Error("fleet secret is required");
  if (!self?.address) throw new Error(`fleet address is required for ${fleet.self}`);
  const { address } = await lookup(self.address);
  const normalized = address.includes(":") ? new URL(`http://[${address}]/`).hostname : address;
  if (["0.0.0.0", "[::]", "[::ffff:0:0]"].includes(normalized)) throw new Error("fleet address must name one interface");
  const server = createServer((req, res) => {
    const reply = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.method === "GET" && req.url === "/health") { reply(200, { ok: true, instance }); return; }
    if (req.method !== "POST" || req.url !== "/message") { reply(404, { ok: false, reason: "not-found" }); req.resume(); return; }
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > LIMIT) {
        if (!res.writableEnded) reply(413, { ok: false, reason: "body-too-large" });
        chunks.length = 0;
      } else chunks.push(chunk);
    });
    req.on("error", () => { if (!res.writableEnded) reply(400, { ok: false, reason: "bad-body" }); });
    req.on("end", () => {
      if (res.writableEnded) return;
      let message;
      try { message = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { reply(400, { ok: false, reason: "bad-json" }); return; }
      try {
        const time = clock();
        const seen = pruneSeen(readState(root, "seen"), time);
        const result = verifyMessage(message, { secret: fleet.secret, nodes: fleet.nodes, seen, now: time });
        if (!result.ok) { reply(400, result); return; }
        if (message.kind === "heartbeat" && !(typeof message.body.leader === "boolean" && (message.body.kit === null || typeof message.body.kit === "string"))) {
          reply(400, { ok: false, reason: "bad-heartbeat" }); return;
        }
        // No await between verification and persistence: requests cannot race the saved IDs.
        if (message.kind !== "heartbeat") writeState(root, "queue", [...readState(root, "queue"), message]);
        writeState(root, "seen", seen);
        if (message.kind === "heartbeat") {
          const peers = readState(root, "peers");
          Object.defineProperty(peers, message.from, { value: { time, kit: message.body.kit, leader: message.body.leader }, enumerable: true, configurable: true, writable: true });
          writeState(root, "peers", peers);
        }
        reply(202, { ok: true });
      } catch {
        reply(500, { ok: false, reason: "state-error" });
      }
    });
  });
  server.requestTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: address, port: listen.port ?? self.port ?? 8080 }, () => { server.off("error", reject); resolve(); });
  });
  return server;
}

const unsignedFields = ({ sig: _sig, time: _time, ...fields }) => fields;

async function post(node, fields, secret, fetch, clock, signal) {
  signal?.throwIfAborted();
  const message = createMessage({ ...fields, time: new Date(clock()).toISOString() }, secret);
  const timeout = AbortSignal.timeout(5000);
  const response = await fetch(`${endpoint(node)}/message`, { method: "POST", body: JSON.stringify(message),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (response.status === 202) return { delivered: true };
  if (response.status >= 400 && response.status < 500) {
    let reason = "unknown";
    try { const data = await response.json(); if (typeof data?.reason === "string") reason = data.reason; }
    catch { /* A terminal HTTP status remains terminal without a JSON body. */ }
    return { delivered: reason === "seen-id", terminal: true, status: response.status, reason };
  }
  return { retry: true };
}

function deadLetter(root, entry, result) {
  writeState(root, "dead", [...readState(root, "dead"), { ...entry, status: result.status, reason: result.reason }].slice(-100));
}

/** Keep unsigned messages only for transient failures; permanent refusals are bounded. */
export async function sendMessage({ root = process.cwd(), fleet, node, message, fetch = nodeFetch, clock = Date.now, signal }) {
  if (signal?.aborted) return false;
  const fields = unsignedFields(message);
  const entry = { node: node.id, message: fields, attempts: 1, nextAttempt: clock() + 1000 };
  let result;
  try { result = await post(node, fields, fleet.secret, fetch, clock, signal); }
  catch { result = { retry: true }; }
  if (result.delivered) return true;
  if (fields.kind === "heartbeat") return false;
  if (result.terminal) deadLetter(root, entry, result);
  else writeState(root, "outbox", [...readState(root, "outbox"), entry]);
  return false;
}

/** Only a transient failure holds later messages behind the oldest entry. */
export async function flushOutbox({ root = process.cwd(), fleet, fetch = nodeFetch, clock = Date.now, signal }) {
  if (signal?.aborted) return;
  const pending = readState(root, "outbox");
  for (const entry of pending) {
    if (signal?.aborted) return;
    if (entry.nextAttempt > clock()) break;
    const node = fleet.nodes.find(node => node.id === entry.node);
    let result;
    try {
      if (!node?.address || node.active === false) throw new Error("peer unavailable");
      result = await post(node, unsignedFields(entry.message), fleet.secret, fetch, clock, signal);
    } catch { result = { retry: true }; }
    if (signal?.aborted) return;
    // Reread after the network await to preserve any concurrently queued sends.
    const current = readState(root, "outbox");
    const index = current.findIndex(item => item.node === entry.node && item.message.id === entry.message.id);
    if (index < 0) continue;
    if (result.retry) {
      const attempts = entry.attempts + 1;
      current[index] = { ...entry, message: unsignedFields(entry.message), attempts, nextAttempt: clock() + Math.min(60_000, 1000 * 2 ** Math.min(attempts - 1, 6)) };
    } else {
      if (!result.delivered) deadLetter(root, entry, result);
      current.splice(index, 1);
    }
    writeState(root, "outbox", current);
    if (result.retry) break;
  }
}

export async function heartbeat({ root = process.cwd(), fleet, repo, kit = null, leader = false, clock = Date.now, fetch = nodeFetch, signal }) {
  for (const node of fleet.nodes) {
    if (signal?.aborted) return;
    if (node.id === fleet.self || node.active === false || !node.address) continue;
    const message = createMessage({ from: fleet.self, repo, kind: "heartbeat", body: { kit, leader }, time: new Date(clock()).toISOString() }, fleet.secret);
    await sendMessage({ root, fleet, node, message, clock, fetch, signal });
  }
}

const sleepFor = ms => new Promise(resolve => setTimeout(resolve, ms));
const removeNode = root => rmSync(path.join(stateDir(root), "node.json"), { force: true, maxRetries: 10, retryDelay: 100 });
function isLive(pid, kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
function localNode(fleet) {
  if (!fleet.secret) throw new Error("fleet secret is required");
  const node = fleet.nodes.find(node => node.id === fleet.self);
  if (!node?.address) throw new Error(`fleet address is required for ${fleet.self}`);
  return node;
}
async function healthy(node, instance, fetch, timeout) {
  if (typeof instance !== "string" || !instance) return false;
  try {
    const response = await fetch(`${endpoint(node)}/health`, { signal: AbortSignal.timeout(Math.max(1, timeout)) });
    if (response.status !== 200) return false;
    const health = await response.json();
    return health.ok === true && health.instance === instance;
  } catch { return false; }
}

export async function startNode({ root = process.cwd(), fleet, leader = false, spawn = spawnProcess,
  kill = process.kill, clock = Date.now, fetch = nodeFetch, sleep = sleepFor, env = process.env }) {
  const self = localNode(fleet);
  const record = readState(root, "node");
  if (Number.isSafeInteger(record.pid) && record.pid > 0) {
    if (!await healthy(self, record.instance, fetch, 1000)) throw new Error("fleet node is stale: instance health does not match");
    if (isLive(record.pid, kill)) return { running: true, already: true };
  }
  const instance = randomUUID();
  mkdirSync(stateDir(root), { recursive: true, mode: 0o700 });
  const log = openSync(path.join(stateDir(root), "node.log"), "a", 0o600);
  let child, spawnError;
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL("./qc.mjs", import.meta.url)), "fleet", "serve", ...(leader ? ["--leader"] : [])],
      { cwd: root, env: { ...env, QC_FLEET_INSTANCE: instance }, detached: true, stdio: ["ignore", log, log], windowsHide: true });
    child.once("error", error => { spawnError = error; });
    child.unref();
  } finally { closeSync(log); }
  try {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error("fleet node spawn failed");
    writeState(root, "node", { pid: child.pid, leader, instance });
    const deadline = clock() + 5000;
    while (clock() < deadline) {
      if (spawnError) throw spawnError;
      if (await healthy(self, instance, fetch, deadline - clock())) {
        if (!isLive(child.pid, kill)) throw new Error("fleet node exited before health was ready");
        return { running: true, already: false };
      }
      await sleep(Math.min(100, Math.max(0, deadline - clock())));
    }
    throw new Error("fleet node health did not become ready within 5 s");
  } catch (error) {
    if (await healthy(self, instance, fetch, 1000) && isLive(child.pid, kill)) kill(child.pid, "SIGTERM");
    removeNode(root);
    throw error;
  }
}

export async function stopNode({ root = process.cwd(), fleet, fetch = nodeFetch, kill = process.kill, clock = Date.now, sleep = sleepFor } = {}) {
  const deadline = clock() + 5000;
  const record = readState(root, "node");
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) { removeNode(root); return { stopped: true, already: true }; }
  if (!await healthy(localNode(fleet), record.instance, fetch, 1000)) throw new Error("fleet node is stale: instance health does not match");
  if (!isLive(record.pid, kill)) { removeNode(root); return { stopped: true, already: true }; }
  try { kill(record.pid, "SIGTERM"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
  while (isLive(record.pid, kill)) {
    if (clock() >= deadline) throw new Error("fleet node did not stop within 5 s");
    await sleep(Math.min(100, deadline - clock()));
  }
  removeNode(root);
  return { stopped: true, already: false };
}

export async function nodeStatus({ root = process.cwd(), fleet, fetch = nodeFetch, clock = Date.now, kill = process.kill }) {
  try { stateDir(root); }
  catch (error) {
    if (error.message !== "fleet state needs a git common dir") throw error;
    return `node=stopped leader=unknown peers=0/${fleet.nodes.filter(node => node.id !== fleet.self).length}`;
  }
  const record = readState(root, "node");
  let status = "stopped";
  if (Number.isSafeInteger(record.pid) && record.pid > 0) {
    const self = fleet.nodes.find(node => node.id === fleet.self);
    status = self?.address && await healthy(self, record.instance, fetch, 1000)
      ? (isLive(record.pid, kill) ? "running" : "stopped") : "stale";
  }
  const running = status === "running";
  const time = clock(), peers = readState(root, "peers");
  const others = fleet.nodes.filter(node => node.id !== fleet.self);
  const recent = others.filter(node => Number.isFinite(peers[node.id]?.time) && time - peers[node.id].time >= 0 && time - peers[node.id].time <= 90_000);
  const leader = running && record.leader ? fleet.self : recent.find(node => peers[node.id].leader === true)?.id ?? "unknown";
  return `node=${status} leader=${leader} peers=${recent.length}/${others.length}`;
}

/** One serial tick avoids overlapping network retries and heartbeats. */
export async function serveNode({ root = process.cwd(), fleet, repo, kit = null, leader = false, clock = Date.now,
  fetch = nodeFetch, listen, instance = process.env.QC_FLEET_INSTANCE || randomUUID(), pid = process.pid, timer = setInterval, clearTimer = clearInterval,
  onSignal = (name, fn) => process.once(name, fn), offSignal = (name, fn) => process.off(name, fn), warn = console.error }) {
  const server = await createNodeServer({ root, fleet, clock, listen, instance });
  const sends = new AbortController();
  let interval, forceClose, busy = false, closing = false, nextHeartbeat = clock() + 30_000;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    clearTimer(interval);
    sends.abort();
    server.close();
    forceClose = setTimeout(() => server.closeAllConnections(), 1000);
    forceClose.unref();
  };
  try { writeState(root, "node", { pid, leader, instance }); }
  catch (error) { server.close(); throw error; }
  interval = timer(async () => {
    if (busy || closing) return;
    busy = true;
    try {
      if (clock() >= nextHeartbeat) {
        nextHeartbeat = clock() + 30_000;
        await heartbeat({ root, fleet, repo, kit, leader, clock, fetch, signal: sends.signal });
      }
      await flushOutbox({ root, fleet, clock, fetch, signal: sends.signal });
    } catch (error) { warn(`fleet node: ${error.message}`); }
    finally { busy = false; }
  }, 1000);
  onSignal("SIGTERM", shutdown);
  onSignal("SIGINT", shutdown);
  server.once("close", () => {
    clearTimeout(forceClose);
    if (!closing) clearTimer(interval);
    closing = true;
    sends.abort();
    offSignal("SIGTERM", shutdown);
    offSignal("SIGINT", shutdown);
    try { const record = readState(root, "node"); if (record.pid === pid && record.instance === instance) removeNode(root); }
    catch (error) { warn(`fleet node: ${error.message}`); }
  });
  return server;
}
