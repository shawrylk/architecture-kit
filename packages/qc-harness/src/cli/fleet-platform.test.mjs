import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn as spawnProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { platformTick, runPlatformCheck } from "./fleet-platform.mjs";
import { readState, writeState } from "./fleet-state.mjs";
import { legRecords } from "./legs.mjs";

const head = "a".repeat(40), now = 100_000;
function fixture(t, self = "leader") {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-platform-"));
  mkdirSync(path.join(root, ".git"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const fleet = { self, secret: "ab".repeat(32), nodes: ["leader", "pusher", "win-z", "win-a", "mac", "dead", "inactive"].map((id, index) =>
    ({ id, address: "localhost", port: 8100 + index, active: id !== "inactive" })) };
  writeState(root, "node", { leader: self === "leader", term: 1 });
  writeState(root, "assignments", { "o/r#244": { repo: "o/r", issue: 244, epoch: 2, node: "pusher" } });
  writeState(root, "peers", {
    leader: { time: now, leader: true, term: 1, os: "linux" }, pusher: { time: now, os: "linux" },
    "win-z": { time: now, os: "windows" }, "win-a": { time: now, os: "windows" }, mac: { time: now, os: "darwin" },
    dead: { time: now - 90_000, os: "darwin" }, inactive: { time: now, os: "darwin" },
  });
  const sent = [], urls = [], calls = [], comments = [], warnings = [];
  const deps = { root, fleet, clock: () => now, config: { check: { base: "base" }, ready: { platforms: ["linux", "windows", "darwin"] } },
    risk: (...args) => { calls.push(["risk", ...args]); return [{ reason: "platform" }]; },
    git: async (...args) => { calls.push(["git", ...args]); return { stdout: args[1] === "rev-parse" ? `${head}\n` : "" }; },
    check: async (...args) => { calls.push(["check", ...args]); return { ok: true, tail: "passed" }; },
    gh: (args, options) => { comments.push({ args, options }); return "comment-url"; },
    fetch: async (url, options) => { urls.push(url); sent.push(JSON.parse(options.body)); return { status: 202 }; },
    warn: text => warnings.push(text) };
  const queue = (kind, body = {}, from = "pusher") => writeState(root, "queue", [...readState(root, "queue"),
    { id: String(readState(root, "queue").length), repo: "o/r", from, kind, body: { issue: 244, epoch: 2, branch: "feat/244", head, ...body } }]);
  return { ...deps, deps, sent, urls, calls, comments, warnings, queue };
}

test("Leader fetches risky pushed heads and chooses the lowest live ID for each other OS", async t => {
  const f = fixture(t);
  f.queue("pushed");
  await platformTick(f.deps);
  assert.deepEqual(f.calls.slice(0, 2), [["git", f.root, "fetch", "origin", "feat/244"], ["risk", f.root, "base", head]]);
  assert.deepEqual(f.sent.map(m => [m.kind, m.body]), ["windows", "darwin"].map(() => ["platform-check", { issue: 244, epoch: 2, branch: "feat/244", head, pusher: "pusher" }]));
  assert.deepEqual(f.urls, ["http://localhost:8103/message", "http://localhost:8104/message"]);
  assert.deepEqual(readState(f.root, "queue"), []);
});

test("pushed rejects wrong owner, epoch, branch and head before git; safe diffs send nothing", async t => {
  const f = fixture(t);
  f.queue("pushed", {}, "mac"); f.queue("pushed", { epoch: 1 });
  f.queue("pushed", { branch: "bad;command" }); f.queue("pushed", { head: "--help" });
  for (let n = 0; n < 4; n++) await platformTick(f.deps);
  assert.deepEqual(f.calls, []);
  f.queue("pushed");
  await platformTick({ ...f.deps, risk: () => [] });
  assert.equal(f.sent.length, 0);
  const peers = readState(f.root, "peers"); delete peers.mac; writeState(f.root, "peers", peers);
  f.queue("pushed"); await platformTick(f.deps);
  assert.deepEqual(f.warnings, ["no live darwin node for #244"]);
});

test("worker accepts only the Leader, checks a detached head serially, and reports to pusher and Leader", async t => {
  const f = fixture(t, "mac");
  f.queue("platform-check", { pusher: "pusher" }, "win-a");
  f.queue("platform-check", { pusher: "pusher", branch: "bad branch" }, "leader");
  await platformTick(f.deps); await platformTick(f.deps);
  assert.deepEqual(f.calls, []);
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  f.queue("platform-check", { pusher: "pusher" }, "leader");
  f.queue("platform-check", { pusher: "pusher" }, "leader");
  const running = platformTick({ ...f.deps, os: "darwin", check: async (cwd, options) => {
    f.calls.push(["check", cwd, options]); await waiting; return { ok: true, tail: "done" };
  } });
  await new Promise(resolve => setImmediate(resolve));
  await platformTick(f.deps);
  assert.equal(f.calls.filter(row => row[0] === "check").length, 1);
  assert.equal(readState(f.root, "queue").length, 1);
  release(); await running;
  const add = f.calls.find(row => row[2] === "worktree" && row[3] === "add");
  assert.deepEqual(add.slice(2, 5), ["worktree", "add", "--detach"]);
  assert.equal(add.at(-1), head);
  const run = f.calls.find(row => row[0] === "check");
  assert.equal(run[1], add[5]);
  assert.equal(run[2].timeout, 30 * 60_000);
  assert.deepEqual(f.calls.at(-1).slice(2), ["worktree", "remove", "--force", add[5]]);
  assert.deepEqual(f.sent.map(m => m.body), [1, 2].map(() => ({ issue: 244, head, os: "darwin", ok: true, tail: "done" })));
});

test("failed setup and runner errors still clean up and send failed results", async t => {
  for (const stage of ["fetch", "add", "check"]) {
    const f = fixture(t, "mac"); f.queue("platform-check", { pusher: "pusher" }, "leader");
    await platformTick({ ...f.deps, os: "darwin", git: async (...args) => {
      f.calls.push(["git", ...args]); if (args.includes(stage)) throw new Error(`${stage} failed`);
    }, check: async () => { throw new Error("check failed"); } });
    assert.equal(f.sent[0].body.ok, false);
    assert.match(f.sent[0].body.tail, new RegExp(`${stage} failed`));
    if (stage !== "fetch") assert.ok(f.calls.some(row => row.includes("remove")));
  }
});

test("only heartbeat-matching passing results add fleet legs; Leader posts Reviewer result comments", async t => {
  const f = fixture(t, "pusher");
  for (const [from, body] of [["mac", { os: "windows", ok: true }], ["mac", { os: "darwin", ok: false }],
    ["mac", { os: "darwin", ok: true }], ["win-a", { os: "windows", ok: true, head: "bad" }]]) {
    f.queue("platform-result", { tail: "output", ...body }, from);
  }
  for (let n = 0; n < 4; n++) await platformTick(f.deps);
  assert.deepEqual(legRecords(f.root).map(({ os, head, source }) => ({ os, head, source })), [{ os: "darwin", head, source: "fleet" }]);
  const leader = fixture(t);
  leader.queue("platform-result", { os: "darwin", ok: false, tail: "error\n```\nend" }, "mac");
  await platformTick(leader.deps);
  assert.equal(leader.comments.length, 1);
  const comment = leader.comments[0].args;
  assert.deepEqual(comment.slice(0, 6), ["issue", "comment", "244", "--repo", "o/r", "--body"]);
  assert.match(comment[6], /Reviewer/);
  assert.match(comment[6], /kind=platform-result/);
  assert.match(comment[6], /platform check on darwin: fail/);
  assert.match(comment[6], /error/);
});

test("checks must leave the requested HEAD and a clean worktree", async t => {
  const f = fixture(t, "mac");
  const git = (cwd, ...args) => ({ stdout: execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) });
  git(f.root, "init");
  git(f.root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "first");
  const other = git(f.root, "rev-parse", "HEAD").stdout.trim();
  git(f.root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "requested");
  const requested = git(f.root, "rev-parse", "HEAD").stdout.trim();
  git(f.root, "remote", "add", "origin", f.root);
  git(f.root, "branch", "feat/244");
  for (const mode of ["moved", "dirty", "hidden-untracked", "clean"]) {
    git(f.root, "config", "status.showUntrackedFiles", mode === "hidden-untracked" ? "no" : "all");
    let checkout;
    f.queue("platform-check", { pusher: "pusher", head: requested }, "leader");
    await platformTick({ ...f.deps, git, check: async cwd => {
      checkout = cwd;
      if (mode === "moved") git(cwd, "checkout", "--detach", other);
      if (["dirty", "hidden-untracked"].includes(mode)) writeFileSync(path.join(cwd, "untracked"), "changed");
      return { ok: true, tail: "command passed\n" };
    } });
    const result = f.sent.at(-1).body;
    assert.equal(existsSync(path.dirname(checkout)), false);
    assert.equal(git(f.root, "worktree", "list", "--porcelain").stdout.includes(checkout), false);
    assert.equal(result.ok, mode === "clean", mode);
    if (mode === "moved") assert.match(result.tail.split("\n").at(-1), /HEAD.*requested/i);
    if (["dirty", "hidden-untracked"].includes(mode)) assert.match(result.tail.split("\n").at(-1), /worktree.*(dirty|clean|changes)/i);
    if (mode === "clean") assert.equal(result.tail, "command passed");
  }
});

async function assertProcessGone(pid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); }
    catch (error) { assert.equal(error.code, "ESRCH"); return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`grandchild ${pid} is still alive`);
}

for (const ending of ["exit 0", "abort"]) {
  test(`${ending} stops a real long-lived grandchild`, { skip: ending === "exit 0" && process.platform === "win32" }, async t => {
    const f = fixture(t, "mac"), controller = new AbortController();
    const heartbeat = path.join(f.root, "heartbeat");
    const grandchildScript = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(heartbeat)}, 'ready'); process.send(process.pid); setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, '.'), 25);`;
    const childScript = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); child.once('message', pid => { console.log(pid); ${ending === "exit 0" ? "process.exit(0);" : ""} }); setInterval(() => {}, 1000);`;
    let child, grandchild, deadline;
    t.after(() => {
      clearTimeout(deadline);
      for (const pid of [grandchild, child?.pid]) {
        if (!pid) continue;
        try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    });
    const running = runPlatformCheck(f.root, { signal: controller.signal, timeout: 10_000,
      spawn: (_command, _args, options) => {
        child = spawnProcess(process.execPath, ["-e", childScript], options);
        child.stdout.once("data", data => {
          grandchild = Number(data.toString().trim());
          if (ending === "abort") controller.abort();
        });
        return child;
      } });
    const result = await Promise.race([running, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error(`${ending} did not settle`)), 4000);
    })]);
    clearTimeout(deadline);
    assert.ok(grandchild > 0);
    if (process.platform !== "win32") await assertProcessGone(grandchild);
    const stopped = readFileSync(heartbeat, "utf8");
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(readFileSync(heartbeat, "utf8"), stopped, "grandchild must stop writing");
    assert.equal(result.ok, false);
    assert.match(result.tail, ending === "exit 0" ? /check left a child process/ : /abort/i);
  });
}

test("timeout stops a real child and its long-lived grandchild and removes the worktree", async t => {
  const f = fixture(t, "mac");
  const heartbeat = path.join(f.root, "heartbeat");
  const grandchildScript = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(heartbeat)}, 'ready'); setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, '.'), 25);`;
  const childScript = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: ['ignore', 'inherit', 'inherit'] }); console.log(child.pid); setInterval(() => {}, 1000);`;
  let child, grandchild, checkout, deadline;
  t.after(() => {
    clearTimeout(deadline);
    for (const pid of [grandchild, child?.pid]) {
      if (!pid) continue;
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  });
  f.queue("platform-check", { pusher: "pusher" }, "leader");
  const running = platformTick({ ...f.deps, check: async (cwd, options) => {
    checkout = cwd;
    return runPlatformCheck(cwd, { ...options, timeout: 1500, spawn: (_command, _args, spawnOptions) => {
      child = spawnProcess(process.execPath, ["-e", childScript], { ...spawnOptions, cwd: f.root });
      child.stdout.once("data", data => { grandchild = Number(data.toString().trim()); });
      return child;
    } });
  } });
  await Promise.race([running, new Promise((_, reject) => {
    deadline = setTimeout(() => reject(new Error("timeout left descendant output pipes open")), 4000);
  })]);
  clearTimeout(deadline);
  assert.ok(grandchild > 0);
  assert.equal(f.sent.at(-1).body.ok, false);
  assert.match(f.sent.at(-1).body.tail, /timed out/);
  assert.equal(existsSync(path.dirname(checkout)), false);
  assert.ok(f.calls.some(row => row[2] === "worktree" && row[3] === "remove" && row[5] === checkout));
  const stopped = readFileSync(heartbeat, "utf8");
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(readFileSync(heartbeat, "utf8"), stopped, "grandchild must stop writing after timeout");
});

test("check runner uses this kit and bounds output to forty lines", async () => {
  let child, invocation;
  const spawn = (...args) => {
    invocation = args;
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    return child;
  };
  const running = runPlatformCheck("/checkout", { spawn, timeout: 1000 });
  child.stdout.write(Array.from({ length: 60 }, (_, n) => `line ${n}\n`).join(""));
  child.stderr.write("last error\n"); child.stdout.end(); child.stderr.end(); child.emit("exit", 1); child.emit("close", 1);
  const result = await running;
  assert.equal(invocation[0], process.execPath);
  assert.deepEqual(invocation[1].slice(1), ["check", "--affected", "--base", "origin/main"]);
  assert.match(invocation[1][0], /qc\.mjs$/);
  assert.equal(invocation[2].cwd, "/checkout");
  assert.equal(invocation[2].detached, process.platform !== "win32");
  assert.equal(result.ok, false); assert.equal(result.tail.split("\n").length, 40);
  assert.equal(result.tail.split("\n").at(-1), "last error");
});

test("check runner drains late output after exit without needing a child close event", async t => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const running = runPlatformCheck("/checkout", { spawn: () => child });
  let deadline;
  t.after(() => { clearTimeout(deadline); child.emit("close", 0); });
  child.emit("exit", 0);
  child.stdout.end("late output\n"); child.stderr.end();
  const result = await Promise.race([running, new Promise((_, reject) => {
    deadline = setTimeout(() => reject(new Error("runner waited for child close after pipes drained")), 1000);
  })]);
  assert.deepEqual(result, { ok: true, tail: "late output" });
});

test("check runner destroys pipes still open five seconds after exit", async t => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const running = runPlatformCheck("/checkout", { spawn: () => child });
  let deadline;
  t.after(() => { clearTimeout(deadline); child.emit("close", 0); });
  child.stdout.write("before exit\n"); child.emit("exit", 0);
  const result = await Promise.race([running, new Promise((_, reject) => {
    deadline = setTimeout(() => reject(new Error("runner did not bound pipe draining after exit")), 6500);
  })]);
  assert.deepEqual(result, { ok: true, tail: "before exit" });
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});

test("Leader retries result comments after gh errors without losing newly queued work", async t => {
  const f = fixture(t);
  f.queue("platform-result", { os: "darwin", ok: true, tail: "passed" }, "mac");
  await assert.rejects(platformTick({ ...f.deps, gh: () => { f.queue("question"); throw new Error("gh offline"); } }), /gh offline/);
  assert.deepEqual(readState(f.root, "queue").map(row => row.kind).sort(), ["platform-result", "question"]);
  await platformTick(f.deps);
  assert.equal(f.comments.length, 1);
  assert.deepEqual(readState(f.root, "queue").map(row => row.kind), ["question"]);
});

test("Leader rechecks ownership and role after fetch and between platform sends", async t => {
  for (const phase of ["fetch", "send"]) {
    const f = fixture(t); f.queue("pushed");
    await platformTick({ ...f.deps, git: async () => {
      if (phase === "fetch") writeState(f.root, "assignments", {});
    }, fetch: async (_url, options) => {
      f.sent.push(JSON.parse(options.body)); writeState(f.root, "node", { leader: false, term: 2 });
      return { status: 202 };
    } });
    assert.equal(f.sent.length, phase === "send" ? 1 : 0);
  }
});

test("large escaped output remains deliverable within the fleet message limit", async t => {
  const f = fixture(t, "mac"); f.queue("platform-check", { pusher: "pusher" }, "leader");
  await platformTick({ ...f.deps, os: "darwin", check: async () => ({ ok: true, tail: "\u0000".repeat(80_000) + "\nlast line\n" }) });
  assert.ok(Buffer.byteLength(JSON.stringify(f.sent[0])) <= 64 * 1024);
  assert.ok(f.sent[0].body.tail.endsWith("last line"));
});
