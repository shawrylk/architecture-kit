import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runFleet } from "./fleet.mjs";
import { readState, writeState } from "./fleet-state.mjs";

function fixture(t, leader = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-talk-"));
  mkdirSync(path.join(root, ".git"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const config = path.join(root, "fleet.json"), file = path.join(root, "text.txt");
  writeFileSync(config, JSON.stringify({ self: "a", secret: "ab".repeat(32), nodes: [
    { id: "a", weight: 1, address: "localhost" }, { id: "b", weight: 1, address: "localhost" },
  ] }));
  writeFileSync(file, "First line\nSecond line");
  writeState(root, "node", { leader });
  writeState(root, "peers", { b: { leader: true } });
  writeState(root, "assignments", { "o/r#7": { repo: "o/r", issue: 7, node: "a", epoch: 3 } });
  const sent = [], comments = [], lines = [], errors = [];
  const run = (args, extra = {}) => runFleet(args, { cwd: root, env: { QC_FLEET_FILE: config }, origin: () => "o/r",
    say: text => lines.push(text), warn: text => errors.push(text),
    gh: args => { comments.push(args); return ""; },
    node: { fetch: async (url, options) => { sent.push({ url, ...JSON.parse(options.body) }); return { status: 202 }; } }, ...extra });
  const queued = (kind, id = "request") => ({ id, from: "b", repo: "o/r", kind, body: { issue: 7, epoch: 3, text: "First?\nSecond?" } });
  return { root, file, run, sent, comments, lines, errors, queued };
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

test("talk rejects invalid arguments, absent ownership or Leader, oversized text and unreadable files", async t => {
  const f = fixture(t);
  for (const args of [["plan", "7"], ["ask", "0", "--file", f.file], ["ask", "7", "--changes"], ["plan", "7", "--file", f.file, "extra"], ["plan", "7", "--file", f.file, "--file", f.file]]) {
    assert.equal(await f.run(args), 1);
  }
  assert.equal(await f.run(["ask", "8", "--file", f.file]), 1);
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
