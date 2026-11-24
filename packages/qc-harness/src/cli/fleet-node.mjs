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
export async function createNodeServer({ root = process.cwd(), fleet, clock = Date.now, listen = {} }) {
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
    if (req.method === "GET" && req.url === "/health") { reply(200, { ok: true }); return; }
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
        writeState(root, "queue", [...readState(root, "queue"), message]);
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
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: address, port: listen.port ?? self.port ?? 8080 }, () => { server.off("error", reject); resolve(); });
  });
  return server;
}

async function post(node, message, fetch) {
  const response = await fetch(`${endpoint(node)}/message`, { method: "POST", body: JSON.stringify(message), signal: AbortSignal.timeout(5000) });
  if (response.status !== 202) throw new Error(`fleet send failed: HTTP ${response.status}`);
}

/** Failed sends stay durable until a retry receives 202. */
export async function sendMessage({ root = process.cwd(), node, message, fetch = nodeFetch, clock = Date.now }) {
  try { await post(node, message, fetch); return true; }
  catch {
    const outbox = readState(root, "outbox");
    outbox.push({ node: node.id, message, attempts: 1, nextAttempt: clock() + 1000 });
    writeState(root, "outbox", outbox);
    return false;
  }
}

/** The first pending message holds later ones until it succeeds. */
export async function flushOutbox({ root = process.cwd(), fleet, fetch = nodeFetch, clock = Date.now }) {
  const pending = readState(root, "outbox");
  for (const entry of pending) {
    if (entry.nextAttempt > clock()) break;
    const node = fleet.nodes.find(node => node.id === entry.node);
    let failed = false;
    try {
      if (!node?.address || node.active === false) throw new Error("peer unavailable");
      await post(node, entry.message, fetch);
    } catch { failed = true; }
    // Reread after the network await to preserve any concurrently queued sends.
    const current = readState(root, "outbox");
    const index = current.findIndex(item => item.node === entry.node && item.message.id === entry.message.id);
    if (index < 0) continue;
    if (failed) {
      const attempts = entry.attempts + 1;
      current[index] = { ...entry, attempts, nextAttempt: clock() + Math.min(60_000, 1000 * 2 ** Math.min(attempts - 1, 6)) };
    } else current.splice(index, 1);
    writeState(root, "outbox", current);
    if (failed) break;
  }
}

export async function heartbeat({ root = process.cwd(), fleet, repo, kit = null, leader = false, clock = Date.now, fetch = nodeFetch }) {
  for (const node of fleet.nodes) {
    if (node.id === fleet.self || node.active === false || !node.address) continue;
    const message = createMessage({ from: fleet.self, repo, kind: "heartbeat", body: { kit, leader }, time: new Date(clock()).toISOString() }, fleet.secret);
    await sendMessage({ root, node, message, clock, fetch });
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
async function healthy(node, fetch, timeout) {
  try {
    const response = await fetch(`${endpoint(node)}/health`, { signal: AbortSignal.timeout(Math.max(1, timeout)) });
    return response.status === 200 && (await response.json()).ok === true;
  } catch { return false; }
}

export async function startNode({ root = process.cwd(), fleet, leader = false, spawn = spawnProcess,
  kill = process.kill, clock = Date.now, fetch = nodeFetch, sleep = sleepFor, env = process.env }) {
  const self = localNode(fleet);
  const record = readState(root, "node");
  if (isLive(record.pid, kill)) {
    if (await healthy(self, fetch, 5000)) return { running: true, already: true };
    throw new Error("fleet node process is live but health is unavailable");
  }
  mkdirSync(stateDir(root), { recursive: true, mode: 0o700 });
  const log = openSync(path.join(stateDir(root), "node.log"), "a", 0o600);
  let child, spawnError;
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL("./qc.mjs", import.meta.url)), "fleet", "serve", ...(leader ? ["--leader"] : [])],
      { cwd: root, env, detached: true, stdio: ["ignore", log, log], windowsHide: true });
    child.once("error", error => { spawnError = error; });
    child.unref();
  } finally { closeSync(log); }
  try {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error("fleet node spawn failed");
    writeState(root, "node", { pid: child.pid, leader });
    const deadline = clock() + 5000;
    while (clock() < deadline) {
      if (spawnError) throw spawnError;
      if (!isLive(child.pid, kill)) throw new Error("fleet node exited before health was ready");
      if (await healthy(self, fetch, deadline - clock())) return { running: true, already: false };
      await sleep(Math.min(100, Math.max(0, deadline - clock())));
    }
    throw new Error("fleet node health did not become ready within 5 s");
  } catch (error) {
    if (isLive(child.pid, kill)) kill(child.pid, "SIGTERM");
    removeNode(root);
    throw error;
  }
}

export async function stopNode({ root = process.cwd(), kill = process.kill, clock = Date.now, sleep = sleepFor } = {}) {
  const record = readState(root, "node");
  if (!isLive(record.pid, kill)) { removeNode(root); return { stopped: true, already: true }; }
  try { kill(record.pid, "SIGTERM"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
  const deadline = clock() + 5000;
  while (isLive(record.pid, kill)) {
    if (clock() >= deadline) throw new Error("fleet node did not stop within 5 s");
    await sleep(Math.min(100, deadline - clock()));
  }
  removeNode(root);
  return { stopped: true, already: false };
}

export function nodeStatus({ root = process.cwd(), fleet, clock = Date.now, kill = process.kill }) {
  try { stateDir(root); }
  catch (error) {
    if (error.message !== "fleet state needs a git common dir") throw error;
    return `node=stopped leader=unknown peers=0/${fleet.nodes.filter(node => node.id !== fleet.self).length}`;
  }
  const record = readState(root, "node");
  const running = isLive(record.pid, kill);
  const time = clock(), peers = readState(root, "peers");
  const others = fleet.nodes.filter(node => node.id !== fleet.self);
  const recent = others.filter(node => Number.isFinite(peers[node.id]?.time) && time - peers[node.id].time >= 0 && time - peers[node.id].time <= 90_000);
  const leader = running && record.leader ? fleet.self : recent.find(node => peers[node.id].leader === true)?.id ?? "unknown";
  return `node=${running ? "running" : "stopped"} leader=${leader} peers=${recent.length}/${others.length}`;
}

/** One serial tick avoids overlapping network retries and heartbeats. */
export async function serveNode({ root = process.cwd(), fleet, repo, kit = null, leader = false, clock = Date.now,
  fetch = nodeFetch, listen, pid = process.pid, timer = setInterval, clearTimer = clearInterval,
  onSignal = (name, fn) => process.once(name, fn), offSignal = (name, fn) => process.off(name, fn), warn = console.error }) {
  const server = await createNodeServer({ root, fleet, clock, listen });
  let interval, busy = false, closing = false, nextHeartbeat = clock() + 30_000;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    clearTimer(interval);
    server.close();
  };
  try { writeState(root, "node", { pid, leader }); }
  catch (error) { server.close(); throw error; }
  interval = timer(async () => {
    if (busy || closing) return;
    busy = true;
    try {
      if (clock() >= nextHeartbeat) {
        nextHeartbeat = clock() + 30_000;
        await heartbeat({ root, fleet, repo, kit, leader, clock, fetch });
      }
      await flushOutbox({ root, fleet, clock, fetch });
    } catch (error) { warn(`fleet node: ${error.message}`); }
    finally { busy = false; }
  }, 1000);
  onSignal("SIGTERM", shutdown);
  onSignal("SIGINT", shutdown);
  server.once("close", () => {
    if (!closing) clearTimer(interval);
    closing = true;
    offSignal("SIGTERM", shutdown);
    offSignal("SIGINT", shutdown);
    try { if (readState(root, "node").pid === pid) removeNode(root); }
    catch (error) { warn(`fleet node: ${error.message}`); }
  });
  return server;
}
