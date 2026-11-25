import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runFleet } from "./fleet.mjs";
import { readState, writeState } from "./fleet-state.mjs";
import { receiveTalk } from "./fleet-talk.mjs";
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
    const [message] = readState(receiver.root, "queue");
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
