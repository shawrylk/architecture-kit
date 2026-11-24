import { execFile, spawn as spawnProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { load } from "../config.mjs";
import { appendLeg, hostOS } from "./legs.mjs";
import { platformRisk } from "./platform-risk.mjs";
import { createMessage } from "./fleet-message.mjs";
import { sendMessage } from "./fleet-node.mjs";
import { highestTerm, latestLeader, livePeer, readState, writeState } from "./fleet-state.mjs";
import { roleComment } from "./role-line.mjs";
import { runGh } from "./gh-run.mjs";

const execute = promisify(execFile);
const runGit = (root, ...args) => execute("git", args, { cwd: root, timeout: 60_000 });
const active = new Set();
const validIssue = value => Number.isSafeInteger(value) && value > 0;
export const validPlatformBranch = value => typeof value === "string" && /^[A-Za-z0-9._/-]+$/.test(value) && !value.startsWith("-");
const validHead = value => typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
const validPush = body => body && validIssue(body.issue) && validIssue(body.epoch) && validPlatformBranch(body.branch) && validHead(body.head);
function tailLines(text) {
  let tail = text.trimEnd().split(/\r?\n/).slice(-40).join("\n");
  while (Buffer.byteLength(JSON.stringify(tail)) > 48_000) tail = tail.slice(Math.max(1, Math.ceil(tail.length / 4)));
  return tail;
}

/** Use this installed kit in the detached checkout, keeping only bounded output. */
export function runPlatformCheck(root, { spawn = spawnProcess, timeout = 30 * 60_000, signal } = {}) {
  return new Promise(resolve => {
    let output = "", expired = false, aborted = false, cleanupFailed = false, leftChild = false, settled = false, timer, drainTimer, child, stopping;
    const append = chunk => { output = (output + chunk.toString()).split(/\r?\n/).slice(-41).join("\n").slice(-48_000); };
    async function stopTree(child) {
      if (!child?.pid) return false;
      if (process.platform === "win32") {
        stopping ??= execute("taskkill", ["/pid", String(child.pid), "/t", "/f"]).catch(error => {
          if (child.exitCode === null && child.signalCode === null) {
            cleanupFailed = true; append(`\nprocess tree cleanup: ${error.message}`);
          }
        });
        await stopping;
        return false;
      }
      try { process.kill(-child.pid, "SIGKILL"); return true; }
      catch (error) {
        if (error.code !== "ESRCH") { cleanupFailed = true; append(`\nprocess tree cleanup: ${error.message}`); }
        return false;
      }
    }
    const onAbort = () => {
      aborted = true; append("\nplatform check aborted");
      void stopTree(child);
    };
    const finish = ok => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(drainTimer);
      signal?.removeEventListener("abort", onAbort);
      child?.stdout?.destroy(); child?.stderr?.destroy();
      resolve({ ok: ok && !expired && !aborted && !leftChild && !cleanupFailed, tail: tailLines(output) });
    };
    try {
      if (signal?.aborted) { onAbort(); finish(false); return; }
      child = spawn(process.execPath, [fileURLToPath(new URL("./qc.mjs", import.meta.url)), "check", "--affected", "--base", "origin/main"],
        { cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
      child.stdout.on("data", append); child.stderr.on("data", append);
      child.once("error", async error => { append(`\n${error.message}`); await stopTree(child); finish(false); });
      child.once("exit", async code => {
        clearTimeout(timer);
        leftChild = await stopTree(child) && !expired && !aborted;
        if (leftChild) append("\ncheck left a child process");
        const drained = () => {
          if ([child.stdout, child.stderr].every(stream => stream.readableEnded || stream.destroyed)) finish(code === 0);
        };
        drainTimer = setTimeout(() => finish(code === 0), 5000);
        for (const stream of [child.stdout, child.stderr]) {
          stream.once("end", drained); stream.once("close", drained);
        }
        drained();
      });
      timer = setTimeout(() => {
        expired = true; append("\nplatform check timed out");
        void stopTree(child);
      }, timeout);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    } catch (error) { append(error.message); finish(false); }
  });
}

function leaderId(root) {
  const peers = readState(root, "peers"), leader = latestLeader(peers, highestTerm(root));
  return Object.keys(peers).find(id => peers[id] === leader);
}

/** Queue before transport so an interrupted command can be retried by the node. */
export async function sendPushed({ root, fleet, repo, issue, epoch, branch, head, node = {}, say = console.log }) {
  const id = leaderId(root), recipient = fleet.nodes.find(row => row.id === id && row.active !== false && row.address);
  if (!recipient) throw new Error("no addressed Leader heartbeat");
  const message = createMessage({ from: fleet.self, repo, kind: "pushed", body: { issue, epoch, branch, head } }, fleet.secret);
  const entry = { node: id, message, attempts: 0, nextAttempt: 0 };
  writeState(root, "outbox", [...readState(root, "outbox"), entry]);
  const { flushOutbox } = await import("./fleet-node.mjs");
  await flushOutbox({ ...node, root, fleet });
  say(`pushed ${message.id}`);
  return 0;
}

async function checkHead({ root, body, git, check, signal }) {
  let temporary, checkout, result;
  try {
    await git(root, "fetch", "origin", body.branch);
    temporary = mkdtempSync(path.join(os.tmpdir(), "qc-fleet-platform-"));
    checkout = path.join(temporary, "checkout");
    await git(root, "-c", "core.ignoreStat=false", "worktree", "add", "--detach", checkout, body.head);
    result = await check(checkout, { timeout: 30 * 60_000, signal });
    const actual = await git(checkout, "rev-parse", "HEAD");
    // A dirty index can make refresh exit nonzero; status below determines cleanliness.
    try { await git(checkout, "-c", "core.ignoreStat=false", "update-index", "--really-refresh"); } catch {}
    const status = await git(checkout, "-c", "core.ignoreStat=false", "status", "--porcelain", "--untracked-files=all");
    if (actual.stdout.trim() !== body.head) {
      result = { ok: false, tail: `${result.tail ?? ""}\nplatform check HEAD ${actual.stdout.trim()} does not match requested head ${body.head}` };
    } else if (status.stdout !== "") {
      result = { ok: false, tail: `${result.tail ?? ""}\nplatform check worktree has uncommitted changes` };
    }
  } catch (error) { result = { ok: false, tail: `${result?.tail ?? ""}\n${error.message}` }; }
  finally {
    if (checkout) {
      try { await git(root, "worktree", "remove", "--force", checkout); }
      catch (error) { result = { ok: false, tail: `${result?.tail ?? ""}\nworktree cleanup: ${error.message}` }; }
    }
    if (temporary) rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return { ok: result.ok === true, tail: tailLines(result.tail ?? "") };
}

/** A separate asynchronous worker leaves the heartbeat tick free during checks. */
export async function platformTick({ root, fleet, clock = Date.now, config, risk = platformRisk, git = runGit,
  check = runPlatformCheck, os = hostOS(), fetch, gh = runGh, signal, warn = console.error }) {
  if (active.has(root) || signal?.aborted) return;
  active.add(root);
  try {
    const queue = readState(root, "queue");
    const message = queue.find(row => ["pushed", "platform-check", "platform-result"].includes(row.kind));
    if (!message) return;
    const { body, from, repo, kind } = message;
    const peers = readState(root, "peers");
    const leader = () => readState(root, "node").leader === true;
    const send = async (id, kind, body) => {
      const node = fleet.nodes.find(row => row.id === id && row.active !== false && row.address);
      if (!node) return;
      const outgoing = createMessage({ from: fleet.self, repo, kind, body, time: new Date(clock()).toISOString() }, fleet.secret);
      if (id === fleet.self) writeState(root, "queue", [...readState(root, "queue"), outgoing]);
      else await sendMessage({ root, fleet, node, message: outgoing, fetch, clock, signal });
    };
    // Remove only this envelope before any await; concurrent deliveries remain queued.
    writeState(root, "queue", queue.filter(row => row !== message));
    if (kind === "pushed") {
      const holds = () => {
        const row = readState(root, "assignments")[`${repo}#${body.issue}`];
        return leader() && row?.node === from && row.epoch === body.epoch;
      };
      if (!validPush(body) || !holds()) return;
      await git(root, "fetch", "origin", body.branch);
      if (!holds()) return;
      config ??= load(root);
      if (risk(root, config.check.base, body.head).length === 0) return;
      for (const platform of config.ready.platforms.filter(platform => platform !== peers[from]?.os)) {
        if (!holds()) return;
        const current = readState(root, "peers");
        const node = fleet.nodes.filter(node => node.active !== false && node.address && current[node.id]?.os === platform &&
          livePeer(current[node.id], clock())).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)[0];
        if (!node) warn(`no live ${platform} node for #${body.issue}`);
        else await send(node.id, "platform-check", { issue: body.issue, epoch: body.epoch, branch: body.branch, head: body.head, pusher: from });
      }
    } else if (kind === "platform-check") {
      if (!validPush(body) || from !== leaderId(root) || !fleet.nodes.some(node => node.id === body.pusher)) return;
      const result = await checkHead({ root, body, git, check, signal });
      for (const id of new Set([body.pusher, from])) await send(id, "platform-result", { issue: body.issue, head: body.head, os, ...result });
    } else {
      if (!body || !validIssue(body.issue) || !validHead(body.head) || !["linux", "windows", "darwin"].includes(body.os) ||
        peers[from]?.os !== body.os || typeof body.ok !== "boolean" || typeof body.tail !== "string") return;
      const assignment = readState(root, "assignments")[`${repo}#${body.issue}`];
      if (assignment?.node === fleet.self && body.ok) appendLeg(root, { os: body.os, head: body.head, source: "fleet" });
      if (leader()) {
        const tail = tailLines(body.tail).replace(/^<!-- qc:v1/gm, " <!-- qc:v1");
        const fence = "`".repeat(Math.max(3, ...Array.from(tail.matchAll(/`+/g), match => match[0].length + 1)));
        const comment = roleComment({ role: "reviewer", node: fleet.self, kind: "platform-result", ref: `#${body.issue}`,
          summary: `platform check on ${body.os}: ${body.ok ? "pass" : "fail"}`, body: `${fence}\n${tail}\n${fence}` }, { secret: fleet.secret });
        try {
          const posted = gh(["issue", "comment", String(body.issue), "--repo", repo, "--body", comment], { cwd: root });
          if (typeof posted !== "string") throw new Error("platform result comment failed");
        } catch (error) {
          writeState(root, "queue", [...readState(root, "queue"), message]);
          throw error;
        }
      }
    }
  } finally { active.delete(root); }
}
