import { execFile, spawn as spawnProcess } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createMessage } from "./fleet-message.mjs";
import { sendMessage } from "./fleet-node.mjs";
import { validPlatformBranch } from "./fleet-platform.mjs";
import { highestTerm, latestLeader, livePeer, readState, stateDir, writeState } from "./fleet-state.mjs";

const execute = promisify(execFile);
const runGit = (root, ...args) => execute("git", args, { cwd: root, timeout: 60_000 });
const ticks = new Set(), running = new Map();
export const liveJob = row => ["starting", "started"].includes(row?.state);
export const validJobId = id => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(id);
export function redactJobText(value, secret) {
  const text = String(value);
  return secret ? text.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[REDACTED]") : text;
}
export function validJob(body) {
  return body && typeof body === "object" && !Array.isArray(body) &&
    Object.keys(body).every(key => ["id", "branch", "base", "brief", "rounds"].includes(key)) &&
    validJobId(body.id) && validPlatformBranch(body.branch) && validPlatformBranch(body.base) &&
    typeof body.brief === "string" && Buffer.byteLength(body.brief) <= 64 * 1024 &&
    Number.isInteger(body.rounds) && body.rounds >= 1 && body.rounds <= 6;
}
export function tailLines(value, secret, count = 20) {
  let tail = redactJobText(value, secret).trimEnd().split(/\r?\n/).slice(-count).join("\n");
  while (Buffer.byteLength(JSON.stringify(tail)) > 48_000) tail = tail.slice(Math.max(1, Math.ceil(tail.length / 4)));
  return tail;
}
function status(row, secret) {
  if (!row.dir) return "";
  let fd;
  try {
    fd = openSync(path.join(row.dir, "loop.status"), "r");
    const size = fstatSync(fd).size, buffer = Buffer.alloc(Math.min(size, 128 * 1024));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return tailLines(buffer.toString("utf8"), secret);
  } catch (error) { if (error.code === "ENOENT") return ""; throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function jobsHeartbeat(root, secret) {
  const saved = readState(root, "jobs-local"), rows = Object.values(saved.jobs ?? {}).filter(liveJob);
  return { max: readState(root, "node").jobs?.max ?? 0, live: rows.length, limitedUntil: saved.limitedUntil ?? 0,
    steps: rows.map(row => ({ id: row.id, step: status(row, secret).split("\n").at(-1).slice(0, 120) })) };
}
export function jobLeader(root, now, self) {
  const peers = readState(root, "peers"), node = readState(root, "node");
  const leader = latestLeader(peers, highestTerm(root));
  const id = Object.keys(peers).find(id => peers[id] === leader && livePeer(leader, now));
  return id ?? (node.leader === true && (node.term ?? 1) >= highestTerm(root) ? self : undefined);
}
async function stopProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    await execute("taskkill", ["/pid", String(child.pid), "/t", "/f"]).catch(error => {
      if (child.exitCode === null && child.signalCode === null) throw error;
    });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}
/** Start only this installed loop. The brief is data on disk, never a shell command. */
export function runJobLoop(root, args, { spawn = spawnProcess, signal, stopTree = stopProcessTree } = {}) {
  return new Promise((resolve, reject) => {
    let child, tail = "", settled = false, stopping, drain;
    const finish = (error, code) => {
      if (settled) return;
      settled = true; clearTimeout(drain); signal?.removeEventListener("abort", abort);
      child?.stdout?.destroy(); child?.stderr?.destroy();
      if (error) reject(error); else resolve({ code, tail });
    };
    const stop = () => stopping ??= stopTree(child);
    const abort = () => { void stop().catch(error => finish(error)); };
    try {
      signal?.throwIfAborted();
      child = spawn(process.execPath, [fileURLToPath(new URL("./qc.mjs", import.meta.url)), "codex-loop", ...args],
        { cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
      const append = chunk => { tail = (tail + chunk.toString()).slice(-48_000); };
      child.stdout.on("data", append); child.stderr.on("data", append);
      child.once("error", error => { void stop().then(() => finish(error), cleanup => finish(cleanup)); });
      child.once("exit", code => {
        // Kill descendants before the checkout can be pushed or removed.
        void stop().then(() => { if (!settled) drain = setTimeout(() => finish(null, code), 5000); }, error => finish(error));
      });
      child.once("close", code => { void (stopping ?? Promise.resolve()).then(() => finish(null, code), error => finish(error)); });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    } catch (error) { finish(error); }
  });
}
function saveJob(root, id, update) {
  const saved = readState(root, "jobs-local"); saved.jobs ??= {};
  saved.jobs[id] = { ...saved.jobs[id], ...update }; writeState(root, "jobs-local", saved);
  return saved.jobs[id];
}
async function result(context, row, state, extra = {}) {
  const { root, fleet, clock = Date.now, fetch, signal } = context;
  const body = { id: row.id, state, ...(row.branch ? { branch: row.branch } : {}), ...extra };
  const node = fleet.nodes.find(node => node.id === row.leader && node.active !== false && node.address);
  if (!node) return;
  const message = createMessage({ from: fleet.self, repo: row.repo, kind: "codex-result", body, time: new Date(clock()).toISOString() }, fleet.secret);
  if (node.id === fleet.self) writeState(root, "queue", [...readState(root, "queue"), message]);
  else await sendMessage({ root, fleet, node, message, clock, fetch, signal });
}
export async function recoverJobs(context) {
  for (const row of Object.values(readState(context.root, "jobs-local").jobs ?? {}).filter(liveJob)) {
    saveJob(context.root, row.id, { state: "failed" });
    await result(context, row, "failed", { reason: "node restarted" });
  }
}
async function executeJob(context, row, entry) {
  const { root, fleet, git = runGit, loop = runJobLoop, spawn, clock = Date.now } = context;
  const signal = entry.controller.signal;
  let state, extra = {};
  try {
    await result(context, row, "started");
    signal.throwIfAborted();
    mkdirSync(row.dir, { recursive: true, mode: 0o700 });
    await git(root, "fetch", "origin", row.base); signal.throwIfAborted();
    await git(root, "worktree", "add", "-b", row.branch, row.worktree, `origin/${row.base}`); signal.throwIfAborted();
    let brief = row.brief;
    for (const [field, value] of [["Worktree", row.worktree], ["Report", path.join(row.dir, "implement-report.md")], ["Progress", path.join(row.dir, "implement-progress.md")]]) {
      const line = `${field}: \`${value}\``;
      brief = new RegExp(`^${field}:.*$`, "m").test(brief) ? brief.replace(new RegExp(`^${field}:.*$`, "m"), () => line) : `${line}\n${brief}`;
    }
    writeFileSync(path.join(row.dir, "implement.md"), brief, { mode: 0o600 });
    saveJob(root, row.id, { state: "started" });
    const output = await loop(row.worktree, ["--dir", row.dir, "--brief", "implement.md", "--rounds", String(row.rounds), "--base", `origin/${row.base}`], { signal, spawn });
    if (entry.cancelled || signal.aborted) state = "cancelled";
    else if (output.code === 0) {
      const head = (await git(row.worktree, "rev-parse", "HEAD")).stdout.trim();
      if (!/^[a-f0-9]{40}$/i.test(head)) throw new Error("job head must be 40 hex characters");
      signal.throwIfAborted();
      await git(row.worktree, "push", "-u", "origin", row.branch);
      signal.throwIfAborted();
      await git(root, "worktree", "remove", row.worktree);
      state = "approved"; extra.head = head;
    } else if (output.code === 2) {
      state = "limit";
      const saved = readState(root, "jobs-local"); saved.limitedUntil = clock() + 60 * 60_000; writeState(root, "jobs-local", saved);
    } else state = "stopped";
    extra.status = status(row, fleet.secret);
  } catch (error) {
    state = entry.cancelled || signal.aborted ? "cancelled" : "failed";
    extra.reason = tailLines(error.message, fleet.secret);
  } finally {
    context.signal?.removeEventListener("abort", entry.abort);
    running.get(root)?.delete(row.id);
  }
  saveJob(root, row.id, { state, time: clock() });
  await result(context, row, state, extra);
}
/** Remove a queue row before the first await, then reserve one slot for each job. */
export async function jobsTick(context) {
  const { root, fleet, clock = Date.now, git = runGit, signal, warn = console.error } = context;
  if (ticks.has(root) || signal?.aborted) return;
  ticks.add(root);
  try {
    const queue = readState(root, "queue"), message = queue.find(row => ["codex-job", "codex-cancel"].includes(row.kind));
    if (!message) return;
    writeState(root, "queue", queue.filter(row => row !== message));
    const body = message.body, row = { id: validJobId(body?.id) ? body.id : "invalid", repo: message.repo, leader: message.from };
    const leader = jobLeader(root, clock(), fleet.self);
    if (message.from !== leader) { await result(context, row, "refused", { reason: "sender is not current leader" }); return; }
    if (message.kind === "codex-cancel") {
      if (!body || !validJobId(body.id) || Object.keys(body).some(key => key !== "id")) return;
      const entry = running.get(root)?.get(body.id);
      if (entry) { entry.cancelled = true; entry.controller.abort(); }
      return;
    }
    const heartbeat = jobsHeartbeat(root, fleet.secret), saved = readState(root, "jobs-local");
    const refusal = !validJob(body) ? "invalid job body" : redactJobText(JSON.stringify(body), fleet.secret) !== JSON.stringify(body) ? "job contains fleet secret" :
      Object.hasOwn(saved.jobs ?? {}, body.id) ? "job id already known" : heartbeat.live >= heartbeat.max ? "no free job slots" :
        clock() < heartbeat.limitedUntil ? "node is limited" : null;
    if (refusal) { await result(context, row, "refused", { reason: refusal }); return; }
    Object.assign(row, body, { dir: path.join(path.dirname(stateDir(root)), "fleet-jobs", body.id), worktree: path.join(root, ".worktree", `fleet-${body.id}`), state: "starting", time: clock() });
    try {
      const local = (await git(root, "for-each-ref", "--format=%(refname)", `refs/heads/${body.branch}`)).stdout.trim().split(/\r?\n/);
      const remote = (await git(root, "ls-remote", "--heads", "origin", `refs/heads/${body.branch}`)).stdout.trim();
      if (local.includes(`refs/heads/${body.branch}`) || remote) { await result(context, row, "refused", { reason: "branch already exists" }); return; }
    } catch (error) { await result(context, row, "failed", { reason: tailLines(error.message, fleet.secret) }); return; }
    signal?.throwIfAborted();
    if (jobLeader(root, clock(), fleet.self) !== message.from) { await result(context, row, "refused", { reason: "sender is not current leader" }); return; }
    saveJob(root, row.id, row);
    const entry = { controller: new AbortController(), cancelled: false };
    entry.abort = () => { entry.cancelled = true; entry.controller.abort(); };
    signal?.addEventListener("abort", entry.abort, { once: true });
    if (!running.has(root)) running.set(root, new Map());
    running.get(root).set(row.id, entry);
    void executeJob(context, row, entry).catch(error => warn(redactJobText(`fleet job: ${error.message}`, fleet.secret)));
  } finally { ticks.delete(root); }
}
