import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { runFleet } from "./fleet.mjs";
import { readState, writeState } from "./fleet-state.mjs";
import { readGithub } from "./fleet-github.mjs";
import { claimUnread, queueReceipt, receiveTalk } from "./fleet-talk.mjs";
import { createMessage } from "./fleet-message.mjs";
import { flushOutbox, receiveMessage } from "./fleet-node.mjs";
import { runWatch } from "./watch.mjs";

function fixture(t, leader = false, self = "a") {
  const other = self === "a" ? "b" : "a";
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-talk-"));
  mkdirSync(path.join(root, ".git"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const config = path.join(root, "fleet.json"), file = path.join(root, "text.txt");
  const fleet = { self, secret: "ab".repeat(32), nodes: [
    { id: "a", weight: 1, address: "localhost" }, { id: "b", weight: 1, address: "localhost" },
  ] };
  writeFileSync(config, JSON.stringify(fleet));
  writeFileSync(file, "First line\nSecond line");
  writeState(root, "node", { leader });
  writeState(root, "peers", { [other]: { leader: !leader, time: Date.now() } });
  writeState(root, "assignments", { "o/r#7": { repo: "o/r", issue: 7, node: leader ? other : self, epoch: 3 } });
  const sent = [], comments = [], lines = [], errors = [];
  const run = (args, extra = {}) => runFleet(args, { cwd: root, env: { QC_FLEET_FILE: config }, origin: () => "o/r",
    say: text => lines.push(text), warn: text => errors.push(text),
    gh: args => { comments.push(args); return ""; },
    node: { fetch: async (url, options) => { sent.push({ url, ...JSON.parse(options.body) }); return { status: 202 }; } }, ...extra });
  const queued = (kind, id = "request") => ({ id, from: other, repo: "o/r", kind, body: { issue: 7, epoch: 3, text: "First?\nSecond?" } });
  return { root, fleet, file, run, sent, comments, lines, errors, queued };
}

test("plan and ask send held issue and epoch to the heartbeat Leader; only plan posts a Coder comment", async t => {
  const f = fixture(t);
  for (const [verb, kind] of [["plan", "plan"], ["ask", "question"]]) {
    assert.equal(await f.run([verb, "7", "--file", f.file]), 0, f.errors.join("\n"));
    assert.equal(f.sent.at(-1).kind, kind);
    assert.deepEqual(f.sent.at(-1).body, { issue: 7, epoch: 3, text: "First line\nSecond line" });
    assert.equal(f.sent.at(-1).from, "a");
    assert.equal(f.sent.at(-1).repo, "o/r");
  }
  assert.equal(f.comments.length, 1);
  const body = f.comments[0][f.comments[0].indexOf("--body") + 1];
  assert.match(body, /Coder/);
  assert.match(body, /kind=plan/);
  assert.match(body, /#7/);
  assert.match(body, /First line\nSecond line/);
});

test("plan and ask refuse queued Leader-only messages when the node is not Leader", async t => {
  for (const verb of ["plan", "ask"]) {
    const f = fixture(t);
    const pending = ["assign", "approve", "answer"].map(kind => ({
      node: "b", message: { ...f.queued(kind, `stale-${kind}`), from: "a" }, attempts: 1, nextAttempt: 0,
    }));
    writeState(f.root, "outbox", pending);

    assert.equal(await f.run([verb, "7", "--file", f.file]), 0, f.errors.join("\n"));
    assert.deepEqual(f.sent.map(message => message.kind), [verb === "plan" ? "plan" : "question"]);
    assert.deepEqual(readState(f.root, "outbox"), []);
    assert.deepEqual(readState(f.root, "dead"), pending.map(entry => ({ ...entry, reason: "not leader" })));
    assert.equal(f.comments.length, verb === "plan" ? 1 : 0);
  }
});

test("talk rejects invalid arguments, absent Leader, oversized text and unreadable files", async t => {
  const f = fixture(t);
  for (const args of [["plan", "7"], ["ask", "0", "--file", f.file], ["ask", "7", "--changes"], ["plan", "7", "--file", f.file, "extra"], ["plan", "7", "--file", f.file, "--file", f.file]]) {
    assert.equal(await f.run(args), 1);
  }
  writeFileSync(f.file, "x".repeat(20001));
  assert.equal(await f.run(["plan", "7", "--file", f.file]), 1);
  assert.match(f.errors.at(-1), /20000/);
  assert.equal(await f.run(["ask", "7", "--file", f.root]), 1);
  assert.match(f.errors.at(-1), /EISDIR|EPERM|EACCES/);
  writeFileSync(f.file, "x".repeat(20000));
  assert.equal(await f.run(["ask", "7", "--file", f.file]), 0);
  writeState(f.root, "peers", { b: { leader: false } });
  assert.equal(await f.run(["ask", "7", "--file", f.file]), 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.comments.length, 0);
});

test("Leader approves or requests changes and answers with quoted question, consuming only the target", async t => {
  const f = fixture(t, true);
  for (const changes of [false, true]) {
    writeState(f.root, "queue", [f.queued("plan"), f.queued("question", "other")]);
    assert.equal(await f.run(["approve", "request", ...(changes ? ["--changes", "--file", f.file] : [])]), 0, f.errors.join("\n"));
    assert.deepEqual(f.sent.at(-1).body, { issue: 7, epoch: 3, plan: "request", approved: !changes, note: changes ? "First line\nSecond line" : "" });
    assert.equal(f.sent.at(-1).kind, "approve");
    assert.equal(readState(f.root, "queue").length, 1);
  }
  writeState(f.root, "queue", [f.queued("question")]);
  assert.equal(await f.run(["answer", "request", "--file", f.file]), 0, f.errors.join("\n"));
  assert.deepEqual(f.sent.at(-1).body, { issue: 7, epoch: 3, question: "request", text: "First line\nSecond line" });
  assert.deepEqual(readState(f.root, "queue"), []);
  const comments = f.comments.map(args => args[args.indexOf("--body") + 1]);
  assert.ok(comments.every(body => /Leader/.test(body)));
  assert.match(comments[0], /kind=approve/);
  assert.match(comments[2], /kind=answer/);
  assert.match(comments[2], /> First\?\n> Second\?/);
});

test("only Leader may reply, reply kinds must match, and unknown IDs fail", async t => {
  const f = fixture(t);
  writeState(f.root, "queue", [f.queued("plan")]);
  assert.equal(await f.run(["approve", "request"]), 1);
  assert.equal(await f.run(["answer", "request", "--file", f.file]), 1);
  writeState(f.root, "node", { leader: true });
  assert.equal(await f.run(["answer", "request", "--file", f.file]), 1);
  assert.equal(await f.run(["approve", "missing"]), 1);
  assert.equal(f.sent.length, 0);
  assert.equal(f.comments.length, 0);
  assert.equal(readState(f.root, "queue").length, 1);
});

test("show reads queue, saved plan decisions and answers by envelope ID", async t => {
  const f = fixture(t);
  writeState(f.root, "queue", [f.queued("plan")]);
  assert.equal(await f.run(["show", "request"]), 0);
  assert.match(f.lines.join("\n"), /plan[\s\S]*b[\s\S]*7[\s\S]*3[\s\S]*First\?/);
  for (const [name, kind] of [["plans", "approve"], ["answers", "answer"]]) {
    writeState(f.root, name, { [name === "plans" ? "o/r#7" : "question-id"]: { ...f.queued(kind, name), body: { issue: 7, epoch: 3, text: "Saved text", note: "Saved note" } } });
    assert.equal(await f.run(["show", name]), 0);
    assert.match(f.lines.at(-1), /Saved/);
  }
  assert.equal(await f.run(["show", "absent"]), 1);
});

test("a failed Leader comment preserves its request and sends no reply", async t => {
  const f = fixture(t, true);
  const request = f.queued("plan");
  writeState(f.root, "queue", [request]);
  assert.equal(await f.run(["approve", "request", "--file", f.file], { gh: () => null }), 1);
  assert.deepEqual(readState(f.root, "queue"), [request]);
  assert.equal(f.sent.length, 0);
});

test("regression: replies reject requests after reassignment or an epoch change before any side effect", async t => {
  const f = fixture(t, true);
  for (const verb of ["approve", "answer"]) {
    for (const assignment of [undefined, { node: "a", epoch: 3 }, { node: "b", epoch: 4 }]) {
      writeState(f.root, "assignments", assignment ? { "o/r#7": { repo: "o/r", issue: 7, ...assignment } } : {});
      const request = f.queued(verb === "approve" ? "plan" : "question");
      const other = f.queued("question", "other");
      writeState(f.root, "queue", [request, other]);
      assert.equal(await f.run([verb, "request", "--file", f.file]), 1, `${verb} must reject a request no longer held at its epoch`);
      assert.match(f.errors.at(-1), /assignment|epoch|hold/i);
      assert.deepEqual(readState(f.root, "queue"), [other]);
      assert.deepEqual(readState(f.root, "outbox"), []);
      assert.equal(f.comments.length, 0);
      assert.equal(f.sent.length, 0);
    }
  }
});

test("regression: plan and ask are durable before network sends and plan comments", async t => {
  const f = fixture(t);
  for (const verb of ["plan", "ask"]) {
    writeState(f.root, "outbox", []);
    let posted = false;
    const checkPending = () => {
      const pending = readState(f.root, "outbox");
      assert.equal(pending.length, 1, `${verb} must enter outbox before external calls`);
      assert.equal(pending[0].node, "b");
      assert.equal(pending[0].message.kind, verb === "plan" ? "plan" : "question");
      return pending[0].message.id;
    };
    let sentId;
    assert.equal(await f.run([verb, "7", "--file", f.file], {
      gh: () => { checkPending(); posted = true; return null; },
      node: { fetch: async () => { sentId = checkPending(); throw new Error("offline"); } },
    }), verb === "plan" ? 1 : 0, f.errors.join("\n"));
    assert.equal(posted, verb === "plan");
    const pending = readState(f.root, "outbox");
    assert.equal(pending.length, 1, "failed external calls must preserve the request");
    assert.equal(sentId, pending[0].message.id, "flushOutbox sends the saved message");
    assert.equal(pending[0].attempts, 1);
  }
});


function deliverTo(f) {
  return { fetch: async (_url, options) => {
    const result = receiveMessage({ root: f.root, fleet: f.fleet, message: JSON.parse(options.body) });
    return { status: result.ok ? 202 : 400, json: async () => result };
  } };
}

test("ask and plan for an unheld issue reach the Leader at epoch zero and get a reply", async t => {
  for (const verb of ["ask", "plan"]) {
    for (const assignments of [{}, { "o/r#19": { node: "b", epoch: 5 } }]) {
      const peer = fixture(t), leader = fixture(t, true, "b");
      for (const f of [peer, leader]) writeState(f.root, "assignments", assignments);
      assert.equal(await peer.run([verb, "19", "--file", peer.file], { node: deliverTo(leader) }), 0, peer.errors.join("\n"));
      receiveTalk(leader.root, leader.fleet, true, Date.now());
      const [request] = readState(leader.root, "queue");
      assert.equal(request.body.epoch, 0);
      assert.equal(request.body.issue, 19);
      assert.equal(request.kind, verb === "ask" ? "question" : "plan");
      const reply = verb === "ask" ? "answer" : "approve";
      assert.equal(await leader.run([reply, request.id, "--file", leader.file], { node: deliverTo(peer) }), 0, leader.errors.join("\n"));
      receiveTalk(peer.root, peer.fleet, false, Date.now());
      const saved = verb === "ask" ? readState(peer.root, "answers")[request.id] : readState(peer.root, "plans")["o/r#19"];
      assert.equal(saved.body.epoch, 0);
      assert.equal(saved.from, "b");
      assert.equal(saved.body.text ?? saved.body.note, "First line\nSecond line");
      assert.deepEqual(readState(leader.root, "queue"), []);
    }
  }
});

test("held issues still reject a zero or stale epoch", t => {
  const leader = fixture(t, true, "b");
  for (const epoch of [0, 2, 4, -1]) {
    writeState(leader.root, "queue", [{ ...leader.queued("question"), body: { issue: 7, epoch, text: "Question" } }]);
    receiveTalk(leader.root, leader.fleet, true, Date.now());
    assert.deepEqual(readState(leader.root, "queue"), []);
  }
});

test("say works peer to Leader and Leader to peer, persists text, and watch/show report it without comments", async t => {
  const peer = fixture(t), leader = fixture(t, true, "b");
  for (const [sender, receiver, target] of [[peer, leader, "leader"], [leader, peer, "a"]]) {
    writeFileSync(sender.file, "Hello from " + sender.fleet.self);
    assert.equal(await sender.run(["say", target, "--file", sender.file], { node: deliverTo(receiver) }), 0, sender.errors.join("\n"));
    const message = readState(receiver.root, "queue").find(message => message.kind === "say");
    assert.equal(message.kind, "say");
    assert.deepEqual(message.body, { text: "Hello from " + sender.fleet.self });
    receiveTalk(receiver.root, receiver.fleet, receiver === leader, Date.now());
    assert.deepEqual(readState(receiver.root, "queue"), []);
    assert.deepEqual(readState(receiver.root, "said")[message.id], message);
    assert.equal(await receiver.run(["show", message.id]), 0, receiver.errors.join("\n"));
    assert.match(receiver.lines.at(-1), new RegExp(`say from=${sender.fleet.self}\\nHello from ${sender.fleet.self}`));
    const events = [];
    assert.equal(await runWatch(["--fleet"], { cwd: receiver.root, say: line => events.push(line),
      gh: () => { throw new Error("say watch must not call GitHub"); }, warn: line => assert.fail(line) }), 0);
    assert.deepEqual(events, [`EVENT fleet:say ${sender.fleet.self} ${message.id}`]);
    assert.equal(sender.comments.length, 0);
    assert.equal(receiver.comments.length, 0);
  }
});

test("say requires a file and a known, addressed, active node with a live heartbeat", async t => {
  const f = fixture(t);
  for (const args of [["say"], ["say", "b"], ["say", "b", "--file"], ["say", "b", "--changes", "--file", f.file],
    ["say", "missing", "--file", f.file], ["say", "a", "--file", f.file]]) {
    assert.equal(await f.run(args), 1, args.join(" "));
  }
  for (const state of [{}, { b: { time: Date.now() - 90_001, leader: true } }, { b: { time: Date.now() + 60_000, leader: true } }]) {
    writeState(f.root, "peers", state);
    for (const target of ["b", "leader"]) assert.equal(await f.run(["say", target, "--file", f.file]), 1);
  }
  writeState(f.root, "peers", { b: { time: Date.now(), leader: false } });
  assert.equal(await f.run(["say", "leader", "--file", f.file]), 1);
  for (const extra of [{ active: false }, { address: undefined }]) {
    const fleet = { ...f.fleet, nodes: f.fleet.nodes.map(node => node.id === "b" ? { ...node, ...extra } : node) };
    writeFileSync(path.join(f.root, "fleet.json"), JSON.stringify(fleet));
    assert.equal(await f.run(["say", "b", "--file", f.file]), 1);
  }
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.comments, []);
});

test("say retries stay on the fleet transport and never fall back to a GitHub comment", async t => {
  const f = fixture(t);
  assert.equal(await f.run(["say", "leader", "--file", f.file], {
    node: { fetch: async () => { throw new Error("offline"); } },
  }), 0, f.errors.join("\n"));
  const [pending] = readState(f.root, "outbox");
  assert.equal(pending.message.kind, "say");
  assert.equal(pending.node, "b");
  writeState(f.root, "outbox", [{ ...pending, attempts: 10, nextAttempt: 0 }]);
  await flushOutbox({ root: f.root, fleet: f.fleet, clock: () => Date.now() + 120_000,
    fetch: async () => ({ status: 202 }), gh: () => assert.fail("say must never post a GitHub comment") });
  assert.deepEqual(readState(f.root, "outbox"), []);
  assert.deepEqual(f.comments, []);
});

test("unsigned, tampered, and unknown senders cannot enqueue say or epoch-zero requests", t => {
  const f = fixture(t, true);
  for (const kind of ["say", "question", "plan"]) {
    const body = kind === "say" ? { text: "Hello" } : { issue: 19, epoch: 0, text: "Question" };
    const message = createMessage({ from: "b", repo: "o/r", kind, body }, f.fleet.secret);
    const { sig: _sig, ...unsigned } = message;
    for (const invalid of [unsigned, { ...message, body: { ...body, text: "tampered" } },
      createMessage({ from: "outsider", repo: "o/r", kind, body }, f.fleet.secret)]) {
      assert.equal(receiveMessage({ root: f.root, fleet: f.fleet, message: invalid }).ok, false);
      assert.deepEqual(readState(f.root, "queue"), []);
      assert.deepEqual(readState(f.root, "seen"), {});
    }
    assert.equal(receiveMessage({ root: f.root, fleet: f.fleet, message }).ok, true);
    writeState(f.root, "queue", []);
    writeState(f.root, "seen", {});
  }
});

test("all talk messages enforce the 20000-character text limit on send and receive", async t => {
  for (const verb of ["ask", "plan", "say", "answer", "approve"]) {
    const f = fixture(t, ["answer", "approve"].includes(verb));
    const target = verb === "say" ? "b" : ["answer", "approve"].includes(verb) ? "request" : "7";
    if (target === "request") writeState(f.root, "queue", [f.queued(verb === "answer" ? "question" : "plan")]);
    writeFileSync(f.file, "x".repeat(20001));
    assert.equal(await f.run([verb, target, "--file", f.file]), 1);
    assert.match(f.errors.at(-1), /20000/);
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.comments, []);
    writeFileSync(f.file, "x".repeat(20000));
    assert.equal(await f.run([verb, target, "--file", f.file]), 0, f.errors.join("\n"));
    assert.equal((f.sent.at(-1).body.text ?? f.sent.at(-1).body.note).length, 20000);
  }
  for (const kind of ["say", "question", "plan", "answer", "approve"]) {
    const f = fixture(t, ["plan", "question"].includes(kind));
    for (const length of [20001, 20000]) {
      const message = createMessage({ from: "b", repo: "o/r", kind,
        body: { issue: 7, epoch: 3, text: "x".repeat(length), note: "x".repeat(length), question: "request", plan: "request", approved: true } }, f.fleet.secret);
      assert.equal(receiveMessage({ root: f.root, fleet: f.fleet, message }).ok, true);
      receiveTalk(f.root, f.fleet, ["plan", "question"].includes(kind), Date.now());
      const saved = kind === "say" ? Object.values(readState(f.root, "said")) : ["question", "plan"].includes(kind)
        ? readState(f.root, "queue") : Object.values(readState(f.root, kind === "answer" ? "answers" : "plans"));
      assert.equal(saved.length, length === 20000 ? 1 : 0, `${kind} text length ${length}`);
    }
  }
});

test("receipt moves sent to delivered; read and done update state without regression", async t => {
  const sender = fixture(t), receiver = fixture(t, true, "b");
  assert.equal(await sender.run(["say", "b", "--file", sender.file], { node: deliverTo(receiver) }), 0);
  const [message] = readState(receiver.root, "queue");
  assert.equal(readState(sender.root, "sent")[message.id].state, "sent");
  assert.equal(readState(sender.root, "sent")[message.id].node, "b");
  await flushOutbox({ root: receiver.root, fleet: receiver.fleet, ...deliverTo(sender) });
  receiveTalk(sender.root, sender.fleet, false, Date.now());
  assert.equal(readState(sender.root, "sent")[message.id].state, "delivered");
  for (const state of ["read", "done", "delivered"]) {
    const receipt = createMessage({ from: "b", repo: "o/r", kind: "receipt", body: { message: message.id, state, note: "handled" } }, sender.fleet.secret);
    assert.equal(receiveMessage({ root: sender.root, fleet: sender.fleet, message: receipt }).ok, true);
    receiveTalk(sender.root, sender.fleet, false, Date.now());
    assert.equal(readState(sender.root, "sent")[message.id].state, state === "delivered" ? "done" : state);
  }
  assert.equal(readState(sender.root, "sent")[message.id].note, "handled");
});

test("escalation preserves a receipt and a new send during event emission", async t => {
  const f = fixture(t);
  writeState(f.root, "sent", { original: { node: "b", repo: "o/r", state: "delivered", time: new Date(0).toISOString() } });
  let sending;
  const lines = [];
  assert.equal(await runWatch(["--fleet"], { cwd: f.root, now: () => 300_000, say: line => {
    lines.push(line);
    const receipt = createMessage({ from: "b", repo: "o/r", kind: "receipt", body: { message: "original", state: "done", note: "finished" } }, f.fleet.secret);
    assert.equal(receiveMessage({ root: f.root, fleet: f.fleet, message: receipt }).ok, true);
    receiveTalk(f.root, f.fleet, false, Date.now());
    sending = f.run(["say", "b", "--file", f.file]);
  } }), 0);
  assert.equal(await sending, 0, f.errors.join("\n"));
  assert.deepEqual(lines, ["EVENT fleet:unread b original"]);
  const sent = readState(f.root, "sent");
  assert.equal(sent.original.state, "done");
  assert.equal(sent.original.note, "finished");
  assert.equal(sent.original.escalated, true);
  assert.equal(sent[f.sent[0].id].state, "sent");
  assert.equal(Object.keys(sent).length, 2);
});

async function killSentHolder(t, root, stage = "published") {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    import path from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    const pause = () => {
      process.send("holding");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    };
    for (const method of ["mkdirSync", "renameSync"]) {
      const original = fs[method];
      fs[method] = (...args) => {
        const result = original(...args);
        const name = path.basename(String(args[method === "renameSync" ? 1 : 0]));
        if (name === "sent.lock" || (process.env.LOCK_STAGE === "prepared" && name.startsWith("sent.lock-"))) pause();
        return result;
      };
    }
    syncBuiltinESMExports();
    const { claimUnread } = await import(process.env.TALK_MODULE);
    claimUnread(process.env.FLEET_ROOT, 300_000);
  `], { env: { ...process.env, FLEET_ROOT: root, LOCK_STAGE: stage,
    TALK_MODULE: new URL("./fleet-talk.mjs", import.meta.url).href }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let errors = "";
  child.stderr.on("data", chunk => { errors += chunk; });
  await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`lock holder exited ${code}: ${errors}`)));
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
}

test("sent writes recover after a holder is killed during lock setup or after publication", { timeout: 15_000 }, async t => {
  for (const stage of ["prepared", "published"]) {
    const f = fixture(t);
    const original = { node: "b", repo: "o/r", state: "sent", time: new Date(0).toISOString() };
    writeState(f.root, "sent", { original });
    await killSentHolder(t, f.root, stage);
    assert.equal(await f.run(["say", "b", "--file", f.file]), 0, f.errors.join("\n"));
    assert.deepEqual(readState(f.root, "sent").original, original);
    writeState(f.root, "queue", [createMessage({ from: "b", repo: "o/r", kind: "receipt",
      body: { message: "original", state: "delivered" } }, f.fleet.secret)]);
    receiveTalk(f.root, f.fleet, false, Date.now());
    assert.deepEqual(claimUnread(f.root, 300_000), [{ id: "original", node: "b" }]);
    assert.deepEqual(claimUnread(f.root, 300_000), []);
    assert.equal(readState(f.root, "sent").original.state, "delivered");
  }
});

test("a new writer during lock release cannot break the releasing writer", { timeout: 10_000 }, async t => {
  const f = fixture(t), resume = new SharedArrayBuffer(4);
  writeState(f.root, "sent", { original: { node: "b", state: "sent", time: new Date(0).toISOString() } });
  const worker = new Worker(`
    const { workerData: d, parentPort } = require("node:worker_threads");
    const fs = require("node:fs"), path = require("node:path");
    for (const method of ["rmdirSync", "renameSync"]) {
      const original = fs[method];
      fs[method] = (...args) => {
        const result = original(...args);
        const releasing = method === "renameSync" ? path.basename(args[0]) === "sent.lock"
          : path.basename(path.dirname(args[0])) === "sent.lock";
        if (releasing) {
          parentPort.postMessage("released");
          Atomics.wait(new Int32Array(d.resume), 0, 0);
        }
        return result;
      };
    }
    require("node:module").syncBuiltinESMExports();
    import(d.module).then(({ claimUnread }) => claimUnread(d.root, 300_000));
  `, { eval: true, workerData: { root: f.root, resume, module: new URL("./fleet-talk.mjs", import.meta.url).href } });
  t.after(() => worker.terminate());
  const finished = new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", code => code === 0 ? resolve() : reject(new Error(`writer exited ${code}`)));
  });
  await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
  assert.deepEqual(claimUnread(f.root, 300_000), []);
  Atomics.store(new Int32Array(resume), 0, 1);
  Atomics.notify(new Int32Array(resume), 0);
  await finished;
  assert.equal(readState(f.root, "sent").original.escalated, true);
});

test("overlapping senders and receipts preserve every sent record and state", { timeout: 15_000 }, async t => {
  const f = fixture(t), count = 6;
  const entries = Object.fromEntries(Array.from({ length: count }, (_, i) => [`old-${i}`, {
    node: "b", repo: "o/r", state: "delivered", time: new Date(0).toISOString(),
  }]));
  writeState(f.root, "sent", entries);
  writeState(f.root, "queue", Object.keys(entries).map(id => createMessage({ from: "b", repo: "o/r", kind: "receipt",
    body: { message: id, state: "done", note: "finished" } }, f.fleet.secret)));
  await killSentHolder(t, f.root);
  const start = new SharedArrayBuffer(4), workers = [];
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  const ready = [], finished = [];
  for (const role of ["sender", "sender", "receipts"]) {
    const worker = new Worker(`
      const { workerData: d, parentPort } = require("node:worker_threads");
      (async () => {
        const fs = require("node:fs"), { syncBuiltinESMExports } = require("node:module");
        const read = fs.readFileSync;
        fs.readFileSync = (...args) => {
          const data = read(...args);
          // Widen the snapshot window so unlocked read/replace writers overlap.
          if (require("node:path").basename(String(args[0])) === "sent.json")
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
          return data;
        };
        syncBuiltinESMExports();
        const { runTalk, receiveTalk } = await import(d.module);
        const start = new Int32Array(d.start);
        parentPort.postMessage("ready");
        Atomics.wait(start, 0, 0);
        if (d.role === "receipts") receiveTalk(d.root, d.fleet, false, Date.now());
        else for (let i = 0; i < d.count; i++) await runTalk({ verb: "say", target: "b", "--file": d.file }, {
          root: d.root, fleet: d.fleet, repo: "o/r", say() {}, warn() {},
          node: { fetch: async () => ({ status: 202 }) },
        });
      })().catch(error => { throw error; });
    `, { eval: true, workerData: { root: f.root, fleet: f.fleet, file: f.file, count, role, start,
      module: new URL("./fleet-talk.mjs", import.meta.url).href } });
    workers.push(worker);
    ready.push(new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); }));
    finished.push(new Promise((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", code => code === 0 ? resolve() : reject(new Error(`writer exited ${code}`)));
    }));
  }
  await Promise.all(ready);
  Atomics.store(new Int32Array(start), 0, 1);
  Atomics.notify(new Int32Array(start), 0);
  await Promise.all(finished);
  const sent = readState(f.root, "sent");
  assert.equal(Object.keys(sent).length, count * 3);
  for (const id of Object.keys(entries)) assert.deepEqual(sent[id], { ...entries[id], state: "done", note: "finished" });
  assert.equal(Object.values(sent).filter(entry => entry.state === "sent").length, count * 2);
});

test("a receipt is never receipted and unsigned receipts are dropped", t => {
  const f = fixture(t);
  const receipt = createMessage({ from: "b", repo: "o/r", kind: "receipt", body: { message: "original", state: "read" } }, f.fleet.secret);
  const { sig: _sig, ...unsigned } = receipt;
  assert.equal(receiveMessage({ root: f.root, fleet: f.fleet, message: unsigned }).reason, "bad-signature");
  assert.deepEqual(readState(f.root, "queue"), []);
  assert.equal(receiveMessage({ root: f.root, fleet: f.fleet, message: receipt }).ok, true);
  receiveTalk(f.root, f.fleet, false, Date.now());
  assert.deepEqual(readState(f.root, "queue"), []);
  assert.deepEqual(readState(f.root, "outbox"), []);
});

test("receipts bind to the recipient and repository and validate state and note", async t => {
  const f = fixture(t);
  await f.run(["say", "b", "--file", f.file]);
  const id = f.sent[0].id;
  for (const fields of [{ from: "a" }, { repo: "x/y" }, { body: { state: "sent" } }, { body: { state: "done", note: "x".repeat(20001) } }]) {
    const message = createMessage({ from: "b", repo: "o/r", kind: "receipt", ...fields,
      body: { message: id, state: "done", ...fields.body } }, f.fleet.secret);
    receiveMessage({ root: f.root, fleet: f.fleet, message });
    receiveTalk(f.root, f.fleet, false, Date.now());
    assert.equal(readState(f.root, "sent")[id].state, "sent");
  }
});

test("ack sends done with an optional bounded note for a stored message", async t => {
  const f = fixture(t);
  const message = createMessage({ from: "b", repo: "o/r", kind: "say", body: { text: "task" } }, f.fleet.secret);
  receiveMessage({ root: f.root, fleet: f.fleet, message });
  receiveTalk(f.root, f.fleet, false, Date.now());
  assert.equal(await f.run(["ack", message.id, "--note", "finished"]), 0, f.errors.join("\n"));
  assert.deepEqual(f.sent.at(-1).body, { message: message.id, state: "done", note: "finished" });
  assert.equal(f.sent.at(-1).kind, "receipt");
  assert.equal(await f.run(["ack", message.id]), 0);
  assert.equal(await f.run(["ack", "missing"]), 1);
  assert.equal(await f.run(["ack", message.id, "--note", "x".repeat(20001)]), 1);
  assert.equal(await f.run(["ack", message.id, "--file", f.file]), 1);
  assert.equal(f.comments.length, 0);
});

test("ack and show retain completed requests and superseded replies by message ID", async t => {
  const leader = fixture(t, true);
  writeState(leader.root, "queue", [leader.queued("plan")]);
  assert.equal(await leader.run(["approve", "request"]), 0);
  assert.equal(await leader.run(["ack", "request"]), 0, leader.errors.join("\n"));
  assert.equal(leader.sent.at(-1).body.state, "done");
  const follower = fixture(t);
  for (const id of ["first", "second"]) {
    writeState(follower.root, "queue", [{ ...follower.queued("approve", id), body: { issue: 7, epoch: 3, plan: "request", approved: true, note: id } }]);
    receiveTalk(follower.root, follower.fleet, false, Date.now());
  }
  for (const id of ["first", "second"]) {
    assert.equal(await follower.run(["show", id]), 0, follower.errors.join("\n"));
    assert.match(follower.lines.at(-1), new RegExp(id));
    assert.equal(await follower.run(["ack", id]), 0);
    assert.equal(follower.sent.at(-1).body.message, id);
    assert.equal(follower.sent.at(-1).body.state, "done");
  }
});


test("issue-routed receipts fall back to GitHub and advance every talk state without loops", async t => {
  for (const kind of ["plan", "question", "approve", "answer"]) {
    const sender = fixture(t), receiver = fixture(t, true, "b");
    const original = createMessage({ from: "a", repo: "o/r", kind, body: { issue: 7 } }, sender.fleet.secret);
    writeState(sender.root, "sent", { [original.id]: { node: "b", repo: "o/r", state: "sent", time: original.time } });
    writeState(receiver.root, "peers", {});
    for (const state of ["delivered", "read", "done"]) {
      if (state === "read") {
        writeState(receiver.root, "node", { leader: false });
        writeState(receiver.root, "received", { [original.id]: original });
        writeState(receiver.root, "inbox", [{ id: original.id, kind, from: "a", repo: "o/r", issue: 7 }]);
        assert.equal(await runWatch(["--fleet"], { cwd: receiver.root, env: { QC_FLEET_FILE: path.join(receiver.root, "fleet.json") }, say: () => {} }), 0);
      } else if (state === "done") {
        assert.equal(await receiver.run(["ack", original.id], { node: { fetch: async () => { throw new Error("offline"); } } }), 0);
      } else queueReceipt(receiver.root, receiver.fleet, original, state);
      const comments = [];
      await flushOutbox({ root: receiver.root, fleet: receiver.fleet, fetch: async () => { throw new Error("offline"); },
        gh: args => { comments.push({ body: args.at(-1), user: { login: "me" }, issue_url: "https://api.github.com/repos/o/r/issues/7", updated_at: new Date().toISOString() }); return ""; } });
      assert.equal(comments.length, 1, `${kind} ${state} must use the issue route`);
      readGithub({ root: sender.root, fleet: sender.fleet, repo: "o/r", gh: args => JSON.stringify(args[1] === "user" ? { login: "me" } : comments) });
      receiveTalk(sender.root, sender.fleet, false, Date.now());
      assert.equal(readState(sender.root, "sent")[original.id].state, state);
      assert.deepEqual(readState(sender.root, "outbox"), []);
      assert.deepEqual(readState(receiver.root, "outbox"), []);
    }
  }
});

test("say warns when no session listens; status exposes session and open-message state and age", async t => {
  const f = fixture(t, true), time = Date.now();
  writeState(f.root, "peers", { b: { time, leader: false, session: "none" } });
  assert.equal(await f.run(["say", "b", "--file", f.file]), 0);
  assert.match(f.errors.at(-1), /no session listens.*b/);
  writeState(f.root, "peers", { b: { time, leader: false, session: "live", sessionHeartbeat: time } });
  f.errors.length = 0;
  assert.equal(await f.run(["say", "b", "--file", f.file]), 0);
  assert.deepEqual(f.errors, []);
  const id = f.sent.at(-1).id, sentAt = Date.parse(f.sent.at(-1).time);
  assert.equal(await f.run(["status"], { gh: () => "[]", git: () => "", node: { clock: () => sentAt + 1000 } }), 0, f.errors.join("\n"));
  assert.match(f.lines.join("\n"), /b .*session=live/);
  assert.ok(f.lines.some(line => line.includes(id) && /state=sent age=1s/.test(line)));
  f.lines.length = 0;
  assert.equal(await f.run(["status"], { gh: () => "[]", git: () => "", node: { clock: () => time + 90_000 } }), 0);
  assert.match(f.lines.join("\n"), /b .*session=none/);
});

test("status includes local session and every open state only for the selected repository", async t => {
  const f = fixture(t, true), at = Date.now();
  writeState(f.root, "node", { leader: true, sessionHeartbeat: at });
  writeState(f.root, "sent", Object.fromEntries([
    ...["sent", "delivered", "read", "done"].map(state => [state, { repo: "o/r", node: "b", state, time: new Date(at - 65_000).toISOString() }]),
    ["other", { repo: "other/repo", node: "b", state: "sent", time: new Date(at).toISOString() }],
  ]));
  assert.equal(await f.run(["status"], { gh: () => "[]", git: () => "", node: { clock: () => at } }), 0, f.errors.join("\n"));
  assert.match(f.lines.join("\n"), /^a .*session=live/m);
  assert.deepEqual(f.lines.filter(line => line.startsWith("message ")), [
    "message sent to=b state=sent age=65s",
    "message delivered to=b state=delivered age=65s",
    "message read to=b state=read age=65s",
  ]);
});
