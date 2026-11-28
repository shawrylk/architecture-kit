import os from "node:os";
import { sampleLoad } from "./fleet-load.mjs";
import { hostOS } from "./legs.mjs";
import { dispatchTick } from "./fleet-dispatch.mjs";
import { platformTick } from "./fleet-platform.mjs";
import { jobsHeartbeat, jobsTick, recoverJobs } from "./fleet-jobs.mjs";
import { randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import { spawn as spawnProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";
import { receiveTalk } from "./fleet-talk.mjs";
import { assignTick, overloaded } from "./fleet-assign.mjs";
import { readOpenAssignments, freeIssues, fleetPath, validateFleet, saveFleet } from "./fleet.mjs";
import { createPairing } from "./fleet-pair.mjs";
import { effectiveFleet, readDiscovered, startDiscovery } from "./fleet-discover.mjs";
import { runGh } from "./gh-run.mjs";
import { createMessage } from "./fleet-message.mjs";
import { githubFallback, postGithubMessage, readGithub, receiveMessage, validBranch, validHead, validWork } from "./fleet-github.mjs";
import { highestTerm, leaderCandidate, leaderDead, livePeer, validTerm, latestLeader, readState, stateDir, writeState } from "./fleet-state.mjs";

export { receiveMessage } from "./fleet-github.mjs";

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
export async function createNodeServer({ root = process.cwd(), fleet, clock = Date.now, listen = {}, instance = randomUUID(), pairing }) {
  const self = fleet.nodes.find(node => node.id === fleet.self);
  if (!fleet.secret && !fleet.discover) throw new Error("fleet secret is required");
  if (!self?.address) throw new Error(`fleet address is required for ${fleet.self}`);
  let address;
  try { ({ address } = await lookup(self.address)); }
  catch { throw new Error(`node ${self.id} address ${self.address} does not resolve to an interface`); }
  const normalized = address.includes(":") ? new URL(`http://[${address}]/`).hostname : address;
  if (["0.0.0.0", "[::]", "[::ffff:0:0]"].includes(normalized)) throw new Error("fleet address must name one interface");
  pairing ??= fleet.key ? createPairing({ root, fleet, clock, address }) : undefined;
  const server = createServer((req, res) => {
    const reply = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.method === "GET" && req.url === "/health") { reply(200, { ok: true, instance }); return; }
    const pairRoute = Boolean(pairing) && req.url === "/pair";
    if (req.method !== "POST" || !(pairRoute || (fleet.secret && req.url === "/message"))) { reply(404, { ok: false, reason: "not-found" }); req.resume(); return; }
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > (pairRoute ? 2048 : LIMIT * 8)) {
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
      if (!pairRoute && size > LIMIT && message?.kind !== "codex-job") { reply(413, { ok: false, reason: "body-too-large" }); return; }
      try {
        const sender = req.socket.remoteAddress?.replace(/^::ffff:/, "");
        const result = pairRoute ? { ok: pairing?.receivePair(message, sender) === true }
          : receiveMessage({ root, fleet, message, clock });
        reply(result.ok ? 202 : 400, result);
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
  // An aborted signal starts no request; post throws, and the catch keeps the message in the outbox.
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

/** Transient HTTP failures hold later HTTP sends; eligible GitHub work can still pass. */
export async function flushOutbox({ root = process.cwd(), fleet, fetch = nodeFetch, clock = Date.now, signal, gh, leader = false,
  allow = (message, role) => allowLeaderMessage(root, fleet, clock(), message, undefined, role) }) {
  if (signal?.aborted) return;
  const fallback = entry => gh && githubFallback({ root, entry, now: clock() });
  const permittedRole = entry => {
    const role = savedRole(root, leader);
    if (allow(entry.message, role)) return role;
    const current = readState(root, "outbox");
    const index = current.findIndex(item => item.node === entry.node && item.message.id === entry.message.id);
    if (index >= 0) {
      deadLetter(root, current[index], { reason: "not leader" });
      current.splice(index, 1);
      writeState(root, "outbox", current);
    }
    return null;
  };
  const pending = readState(root, "outbox");
  let blocked = false;
  for (const entry of pending) {
    if (signal?.aborted) return;
    let role = permittedRole(entry);
    if (!role) continue;
    let result;
    if (fallback(entry)) {
      result = postGithubMessage({ root, fleet, entry, leader: role.leader, clock, gh, signal }) ? { delivered: true } : { githubRetry: true };
    } else {
      if (blocked || entry.nextAttempt > clock()) { blocked = true; continue; }
      const node = fleet.nodes.find(node => node.id === entry.node);
      try {
        if (!node?.address || node.active === false) throw new Error("peer unavailable");
        result = await post(node, unsignedFields(entry.message), fleet.secret, fetch, clock, signal);
      } catch { result = { retry: true }; }
    }
    if (signal?.aborted) return;
    role = permittedRole(entry);
    if (!role) continue;
    // Reread after the network await to preserve any concurrently queued sends.
    const current = readState(root, "outbox");
    const index = current.findIndex(item => item.node === entry.node && item.message.id === entry.message.id);
    if (index < 0) continue;
    if (result.retry) {
      blocked = true;
      const attempts = entry.attempts + 1;
      const retried = { ...entry, message: unsignedFields(entry.message), attempts, nextAttempt: clock() + Math.min(60_000, 1000 * 2 ** Math.min(attempts - 1, 6)) };
      current[index] = retried;
      writeState(root, "outbox", current);
      if (fallback(retried) && postGithubMessage({ root, fleet, entry: retried, leader: role.leader, clock, gh, signal })) {
        const latest = readState(root, "outbox");
        writeState(root, "outbox", latest.filter(item => item.node !== entry.node || item.message.id !== entry.message.id));
      }
      continue;
    }
    if (result.githubRetry) continue;
    if (!result.delivered) deadLetter(root, entry, result);
    current.splice(index, 1);
    writeState(root, "outbox", current);
  }
}

const loadRounds = new Map();

export async function heartbeat({ root = process.cwd(), fleet, repo, kit = null, leader = false, os: host = os, clock = Date.now, fetch = nodeFetch, signal }) {
  const previous = loadRounds.get(root);
  const { platform, cpu, mem, sample } = sampleLoad({ os: host, previous: previous?.sample });
  const load = { platform, cpu, mem, rtt: previous?.rtt ?? null };
  const durations = [];
  // No snapshot survives a network await: confirmation may rebuild assignments during a send.
  const bodyFor = id => {
    const role = savedRole(root, leader);
    const assignments = Object.values(readState(root, "assignments")), saved = readState(root, "work");
    const work = assignments.filter(row => row.node === fleet.self).map(row => {
      const current = saved[`${row.repo}#${row.issue}`]?.epoch === row.epoch ? saved[`${row.repo}#${row.issue}`] : {};
      return { repo: row.repo, issue: row.issue, epoch: row.epoch, step: current.step ?? null,
        branch: current.branch ?? row.branch ?? null, head: current.head ?? row.head ?? null };
    });
    return { kit, os: hostOS(), load, ...role, work, jobs: jobsHeartbeat(root, fleet.secret), ...(role.leader ? { assigned: assignments.filter(row => row.node === id)
      .map(({ repo, issue, epoch }) => ({ repo, issue, epoch })) } : {}) };
  };
  const local = bodyFor(fleet.self);
  if (local.leader) {
    const peers = readState(root, "peers");
    peers[fleet.self] = { time: clock(), ...local };
    writeState(root, "peers", peers);
  }
  for (const node of fleet.nodes) {
    if (signal?.aborted) break;
    if (node.id === fleet.self || node.active === false || !node.address) continue;
    const message = createMessage({ from: fleet.self, repo, kind: "heartbeat", body: bodyFor(node.id),
      time: new Date(clock()).toISOString() }, fleet.secret);
    const started = clock();
    if (await sendMessage({ root, fleet, node, message, clock, fetch, signal })) {
      durations.push(Math.min(600_000, Math.max(0, clock() - started)));
    }
  }
  durations.sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const rtt = durations.length ? (durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2) : null;
  loadRounds.set(root, { sample, rtt });
  const latest = bodyFor(fleet.self);
  if (latest.leader) {
    const peers = readState(root, "peers");
    peers[fleet.self] = { time: clock(), ...latest, load: { platform, cpu, mem, rtt } };
    writeState(root, "peers", peers);
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
  if (!fleet.secret && !fleet.discover) throw new Error("fleet secret is required");
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

export async function startNode({ root = process.cwd(), fleet, leader = false, jobs = 0, spawn = spawnProcess,
  kill = process.kill, clock = Date.now, fetch = nodeFetch, sleep = sleepFor, env = process.env }) {
  const self = localNode(fleet);
  const record = readState(root, "node");
  if (Number.isSafeInteger(record.pid) && record.pid > 0) {
    if (isLive(record.pid, kill)) {
      if (!await healthy(self, record.instance, fetch, 1000)) throw new Error("fleet node is stale: instance health does not match");
      return { running: true, already: true };
    }
    removeNode(root);
  }
  const instance = randomUUID();
  mkdirSync(stateDir(root), { recursive: true, mode: 0o700 });
  const log = openSync(path.join(stateDir(root), "node.log"), "a", 0o600);
  let child, spawnError;
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL("./qc.mjs", import.meta.url)), "fleet", "serve", ...(leader ? ["--leader"] : []), ...(jobs ? ["--jobs", String(jobs)] : [])],
      { cwd: root, env: { ...env, QC_FLEET_INSTANCE: instance }, detached: true, stdio: ["ignore", log, log], windowsHide: true });
    child.once("error", error => { spawnError = error; });
    child.unref();
  } finally { closeSync(log); }
  try {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error("fleet node spawn failed");
    writeState(root, "node", { pid: child.pid, leader, instance, jobs: { max: jobs } });
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
  if (!isLive(record.pid, kill)) { removeNode(root); return { stopped: true, already: true }; }
  if (!await healthy(localNode(fleet), record.instance, fetch, 1000)) throw new Error("fleet node is stale: instance health does not match");
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
  const leader = running && record.leader ? fleet.self : recent.find(node => peers[node.id].leader === true && (peers[node.id].term ?? 1) >= highestTerm(root))?.id ?? "unknown";
  const proposal = readState(root, "proposal");
  const loads = recent.map(node => {
    const load = peers[node.id].load;
    const percent = value => value == null ? "-" : `${Math.round(value * 100)}%`;
    return `\nload ${node.id} cpu=${percent(load?.cpu)} mem=${percent(load?.mem)} rtt=${load?.rtt == null ? "-" : `${load.rtt}ms`}${overloaded(load).length ? " overloaded" : ""}`;
  }).join("");
  return `node=${status} leader=${leader} peers=${recent.length}/${others.length}` + loads +
    (proposal.id && validTerm(proposal.term) ? `\nproposed Leader ${proposal.id} term ${proposal.term}: run npx architecture-harness fleet confirm-leader` : "");
}

/** Consume assignments only after checking the sender's latest leadership claim. */
function receiveAssignments(root, fleet, now, leader) {
  const queue = readState(root, "queue"), peers = readState(root, "peers"), assignments = readState(root, "assignments");
  const snapshot = latestLeader(peers, highestTerm(root));
  const kept = [];
  for (const message of queue) {
    if (message.kind !== "assign") { kept.push(message); continue; }
    const { issue, epoch } = message.body ?? {};
    if (!Number.isSafeInteger(issue) || issue <= 0 || !Number.isSafeInteger(epoch) || epoch <= 0 ||
      !validBranch(message.body.branch) || !validHead(message.body.head)) continue;
    const claim = (peers[message.from]?.term ?? 1) < highestTerm(root) ? false : peers[message.from]?.leader;
    if (claim !== true) {
      if (claim !== false && now - Date.parse(message.time) < 600_000) kept.push(message);
      continue;
    }
    const key = `${message.repo}#${issue}`;
    if (!assignments[key] || epoch > assignments[key].epoch) {
      if (!leader && snapshot && (peers[message.from] !== snapshot ||
        !snapshot.assigned?.some(item => item.repo === message.repo && item.issue === issue && item.epoch === epoch))) {
        if (peers[message.from] === snapshot && now - Date.parse(message.time) < 600_000) kept.push(message);
        continue;
      }
      assignments[key] = { repo: message.repo, issue, node: fleet.self, epoch, time: now,
        ...(message.body.branch ? { branch: message.body.branch } : {}), ...(message.body.head ? { head: message.body.head } : {}) };
    }
  }
  let removed = false;
  if (!leader && snapshot && !leaderDead(root, now)) {
    for (const [key, row] of Object.entries(assignments)) {
      if (row.node === fleet.self && !snapshot.assigned?.some(item => item.repo === row.repo && item.issue === row.issue && item.epoch === row.epoch)) {
        delete assignments[key];
        removed = true;
      }
    }
  }
  if (removed || queue.some(message => message.kind === "assign")) {
    writeState(root, "assignments", assignments);
    writeState(root, "queue", kept);
  }
}

async function assignWork({ root, fleet, repo, kit, term, clock, gh, git, holdLabel, fetch, signal, warn }) {
  const { free } = freeIssues(repo, root, { gh, git, holdLabel });
  const rows = JSON.parse(gh(["issue", "list", "--state", "open", "--limit", "500", "--json", "number", "--repo", repo], { cwd: root }));
  if (!Array.isArray(rows) || !rows.every(row => Number.isSafeInteger(row?.number) && row.number > 0)) throw new Error("gh issue list returned no readable list");
  const result = assignTick({ fleet, repo, kit, now: clock(), free, open: new Set(rows.map(row => row.number)),
    assignments: readState(root, "assignments"), peers: readState(root, "peers") });
  writeState(root, "assignments", result.assignments);
  const outbox = readState(root, "outbox");
  const pending = result.messages.filter(({ node, body }) => !outbox.some(entry => entry.node === node &&
    entry.message.kind === "assign" && entry.message.repo === repo &&
    entry.message.body.issue === body.issue && entry.message.body.epoch === body.epoch))
    .map(({ node, kind, body }) => ({ node, attempts: 0, nextAttempt: clock(),
    message: unsignedFields(createMessage({ from: fleet.self, repo, kind, body, time: new Date(clock()).toISOString() }, fleet.secret)) }));
  if (pending.length) writeState(root, "outbox", [...outbox, ...pending]);
  for (const warning of result.warnings) warn(warning);
  await flushOutbox({ root, fleet, clock, fetch, signal, gh, leader: true,
    allow: (message, role) => allowLeaderMessage(root, fleet, clock(), message, term, role) });
}

/** Read the durable role before every Leader action, including after a network await. */
function savedRole(root, fallbackLeader = false) {
  const record = readState(root, "node"), term = highestTerm(root, record);
  if (record.leader && term > (record.term ?? 1)) {
    writeState(root, "node", { ...record, leader: false, term });
    return { leader: false, term };
  }
  return { leader: record.leader === undefined ? fallbackLeader : record.leader === true, term };
}

function allowLeaderMessage(root, fleet, now, message, term, role = savedRole(root)) {
  if (!["assign", "approve", "answer", "codex-job", "codex-cancel"].includes(message.kind)) return true;
  return role.leader && (term === undefined || role.term === term) && canAssign(root, fleet, now);
}

/** A disconnected Leader pauses assignment after the same grace period as peer death. */
function canAssign(root, fleet, now) {
  const election = readState(root, "election");
  return now - (election.lastPeerAt ?? election.started ?? now) < 90_000;
}

async function electionTick({ root, fleet, repo, clock, fetch, signal }) {
  const now = clock(), peers = readState(root, "peers"), record = readState(root, "node");
  const election = readState(root, "election");
  const live = fleet.nodes.filter(node => node.id !== fleet.self && node.active !== false && node.address && livePeer(peers[node.id], now));
  if (live.length) election.lastPeerAt = Math.max(...live.map(node => peers[node.id].time));
  election.highest = highestTerm(root);
  writeState(root, "election", election);
  const dead = !record.leader && leaderDead(root, now), candidate = leaderCandidate(root, fleet, now);
  const send = async (node, kind, term) => sendMessage({ root, fleet, node, clock, fetch, signal,
    message: createMessage({ from: fleet.self, repo, kind, body: { term, ...(kind === "leader" ? { accept: true } : {}) },
      time: new Date(now).toISOString() }, fleet.secret) });
  const kept = [], replies = [];
  for (const message of readState(root, "queue")) {
    if (!["propose-leader", "leader"].includes(message.kind)) { kept.push(message); continue; }
    const term = message.body?.term, sender = live.find(node => node.id === message.from);
    if (!validTerm(term) || !sender || term < election.highest) continue;
    const previous = election.highest;
    election.highest = term;
    if (message.kind === "propose-leader") {
      if (!dead || candidate !== message.from || term <= (record.term ?? 1) || (election.votedTerm ?? 0) >= term) continue;
      election.votedTerm = term;
      writeState(root, "election", election); // Save the vote before attempting delivery.
      replies.push([sender, "leader", term]);
    } else if (dead && candidate === fleet.self && message.body.accept === true &&
      election.candidateTerm === term && previous <= term) {
      writeState(root, "proposal", { id: fleet.self, term });
    }
  }
  writeState(root, "queue", kept);
  const proposal = readState(root, "proposal");
  const retry = (proposal.id !== fleet.self || proposal.term !== election.candidateTerm) &&
    (election.candidateAt === undefined || now - election.candidateAt >= 30_000);
  if (dead && candidate === fleet.self && live.length && (!election.candidateTerm || election.candidateTerm < election.highest || retry)) {
    const term = election.highest + 1;
    if (!validTerm(term)) throw new Error("fleet term exhausted");
    election.highest = term;
    election.candidateTerm = term;
    election.candidateAt = now;
    election.votedTerm = term;
    writeState(root, "election", election);
    for (const node of live) replies.push([node, "propose-leader", term]);
  }
  for (const peer of Object.values(peers)) if ((peer.term ?? 1) < election.highest) peer.leader = false;
  writeState(root, "peers", peers);
  writeState(root, "election", election);
  for (const [node, kind, term] of replies) await send(node, kind, term);
}

/** Confirmation is local and explicit; live work snapshots rebuild the new Leader's ledger. */
export function confirmLeader({ root, fleet, clock = Date.now }) {
  const now = clock(), record = readState(root, "node"), proposal = readState(root, "proposal");
  const highest = highestTerm(root);
  if (record.leader || !leaderDead(root, now)) throw new Error("Leader is still alive");
  if (leaderCandidate(root, fleet, now) !== fleet.self) throw new Error("this node is not the next Leader candidate");
  const two = fleet.nodes.length === 2;
  let term;
  if (proposal.id || proposal.term) {
    if (proposal.id !== fleet.self || !validTerm(proposal.term) || proposal.term < highest) throw new Error("Leader proposal is stale");
    term = proposal.term;
  } else {
    if (!two) throw new Error("no Leader proposal: wait for a live peer to accept");
    term = highest + 1;
  }
  if (!validTerm(term)) throw new Error("fleet term exhausted");
  const assignments = {}, peers = readState(root, "peers"), work = readState(root, "work");
  const selfWork = Object.values(readState(root, "assignments")).filter(row => row.node === fleet.self).map(row => {
    const saved = work[`${row.repo}#${row.issue}`];
    return saved?.epoch === row.epoch ? saved : { ...row, step: null };
  });
  for (const node of fleet.nodes) {
    if (node.id !== fleet.self && (node.active === false || !livePeer(peers[node.id], now))) continue;
    for (const row of node.id === fleet.self ? selfWork : peers[node.id]?.work ?? []) {
      if (!validWork(row)) continue;
      const key = `${row.repo}#${row.issue}`;
      if (!assignments[key] || row.epoch > assignments[key].epoch) assignments[key] = { ...row, node: node.id, time: now };
    }
  }
  writeState(root, "assignments", assignments);
  writeState(root, "election", { ...readState(root, "election"), highest: term, lastLeaderAt: now });
  writeState(root, "node", { ...record, leader: true, term });
  writeState(root, "proposal", {});
  return term;
}

/** One serial tick avoids overlapping network retries and heartbeats. */
export async function serveNode({ root = process.cwd(), fleet, repo, kit = null, leader = false, jobs = 0, os: host = os, clock = Date.now,
  configuredFleet = fleet, interfaces, discovery = {}, env = process.env, fleetFile = env.QC_FLEET_FILE,
  fetch = nodeFetch, gh = runGh, git, platform = {}, holdLabel = "hold", listen, instance = process.env.QC_FLEET_INSTANCE || randomUUID(), pid = process.pid, timer = setInterval, clearTimer = clearInterval,
  onSignal = (name, fn) => process.once(name, fn), offSignal = (name, fn) => process.off(name, fn), warn = console.error }) {
  const configured = { ...configuredFleet, nodes: configuredFleet.nodes.map(node => ({ ...node })) };
  const refreshFleet = () => {
    if (!configured.discover) return;
    try {
      const currentFile = fleetFile ? validateFleet(JSON.parse(readFileSync(fleetFile, "utf8"))) : configured;
      if (currentFile.self !== fleet.self) throw new Error("running fleet identity changed");
      Object.assign(configured, currentFile);
      fleet.secret = currentFile.secret;
      fleet.key = currentFile.key;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const current = effectiveFleet(configured, readDiscovered(root, configured.secret), clock(), interfaces);
    fleet.nodes = current.nodes;
    fleet.leaders = current.leaders;
  };
  refreshFleet();
  const pairing = fleet.discover && fleet.key ? createPairing({ root, fleet, clock, fetch, warn,
    address: fleet.nodes.find(node => node.id === fleet.self)?.address,
    leader: () => savedRole(root, leader).leader,
    saveSecret: secret => {
      const file = fleetFile ?? fleetPath(env), value = JSON.parse(readFileSync(file, "utf8"));
      if (value.self !== fleet.self || value.key?.public !== fleet.key.public) throw new Error("running fleet identity changed");
      saveFleet(file, { ...value, secret });
    } }) : undefined;
  const server = await createNodeServer({ root, fleet, clock, listen, instance, pairing });
  let discoverySocket;
  try { if (fleet.discover) discoverySocket = await startDiscovery({ ...discovery, root, fleet, address: server.address().address, clock, interfaces, warn, pairing }); }
  catch (error) { server.close(); throw error; }
  const sends = new AbortController();
  let interval, forceClose, busy = false, closing = false, nextHeartbeat = clock() + 30_000, nextAssign = clock() + 60_000, nextGithub = clock();
  const shutdown = () => {
    if (closing) return;
    closing = true;
    discoverySocket?.close();
    clearTimer(interval);
    sends.abort();
    server.close();
    forceClose = setTimeout(() => server.closeAllConnections(), 1000);
    forceClose.unref();
  };
  try {
    const previous = readState(root, "node"), election = readState(root, "election");
    leader = leader || previous.leader === true;
    writeState(root, "node", { pid, leader, instance, term: previous.term ?? highestTerm(root), jobs: { max: jobs } });
    writeState(root, "election", { ...election, started: election.started ?? clock(), highest: highestTerm(root) });
    await recoverJobs({ root, fleet, clock, fetch, signal: sends.signal });
  }
  catch (error) { discoverySocket?.close(); server.close(); throw error; }
  interval = timer(async () => {
    if (busy || closing) return;
    busy = true;
    try {
      refreshFleet();
      await pairing?.tick();
      if (!fleet.secret) return;
      if (clock() >= nextGithub) {
        nextGithub = clock() + 120_000;
        readGithub({ root, fleet, repo, clock, gh });
      }
      await electionTick({ root, fleet, repo, clock, fetch, signal: sends.signal });
      leader = savedRole(root).leader;
      receiveAssignments(root, fleet, clock(), leader);
      receiveTalk(root, fleet, leader, clock());
      dispatchTick({ root, fleet, clock });
      void platformTick({ ...platform, root, fleet, clock, gh, fetch, signal: sends.signal, warn })
        .catch(error => warn(`fleet platform: ${error.message}`));
      void jobsTick({ root, fleet, clock, fetch, signal: sends.signal, warn }).catch(error => warn(`fleet jobs: ${error.message}`));
      await flushOutbox({ root, fleet, clock, fetch, signal: sends.signal, gh, leader,
        allow: (message, role) => allowLeaderMessage(root, fleet, clock(), message, undefined, role) });
      if (!closing && clock() >= nextAssign) {
        nextAssign = clock() + 60_000;
        const role = savedRole(root);
        if (role.leader && canAssign(root, fleet, clock())) await assignWork({ root, fleet, repo, kit, term: role.term, clock, gh, git, holdLabel, fetch, signal: sends.signal, warn });
        else if (!role.leader) {
          const repos = new Set(Object.values(readState(root, "assignments")).filter(row => row.node === fleet.self).map(row => row.repo));
          for (const repo of repos) {
            const open = new Set(readOpenAssignments({ root, fleet, repo, gh, warn }).map(row => row.issue));
            const assignments = readState(root, "assignments");
            const kept = Object.fromEntries(Object.entries(assignments).filter(([, row]) =>
              row.repo !== repo || row.node !== fleet.self || open.has(row.issue)));
            if (Object.keys(kept).length !== Object.keys(assignments).length) writeState(root, "assignments", kept);
          }
        }
      }
    } catch (error) { warn(`fleet node: ${error.message}`); }
    finally {
      try {
        if (!closing && fleet.secret && clock() >= nextHeartbeat) {
          nextHeartbeat = clock() + 30_000;
          leader = savedRole(root).leader;
          await heartbeat({ root, fleet, repo, kit, leader, os: host, clock, fetch, signal: sends.signal });
        }
      } catch (error) { warn(`fleet node: ${error.message}`); }
      finally { busy = false; }
    }
  }, 1000);
  onSignal("SIGTERM", shutdown);
  onSignal("SIGINT", shutdown);
  server.once("close", () => {
    discoverySocket?.close();
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
