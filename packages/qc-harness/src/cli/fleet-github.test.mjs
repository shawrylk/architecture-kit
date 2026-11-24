import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createMessage, verifyMessage } from "./fleet-message.mjs";
import { roleComment, parseMarker } from "./role-line.mjs";
import { readState, writeState } from "./fleet-state.mjs";
import { flushOutbox, receiveMessage, createNodeServer } from "./fleet-node.mjs";
import { readGithub } from "./fleet-github.mjs";

const now = Date.parse("2026-11-24T00:00:00Z");
const secret = "ab".repeat(32);
const kinds = ["assign", "plan", "approve", "question", "answer", "pushed", "verdict", "platform-check", "platform-result"];
const fleet = { self: "a", secret, nodes: [{ id: "a", address: "127.0.0.1" }, { id: "b", address: "127.0.0.1" }] };
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-github-"));
  mkdirSync(path.join(root, ".git"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  writeState(root, "peers", { b: { time: now } });
  return root;
}
const message = (patch = {}) => createMessage({ from: "b", repo: "o/r", kind: "question", body: { issue: 7, text: "private payload" }, time: new Date(now).toISOString(), ...patch }, secret);
const entry = (patch = {}) => ({ node: "b", message: message({ from: "a", time: new Date(now - 600_000).toISOString() }), attempts: 3, nextAttempt: now + 60_000, ...patch });
function comment(msg = message(), { to = "a", author = "me", marker = {}, body } = {}) {
  return { user: { login: author }, issue_url: `https://api.github.com/repos/${msg.repo}/issues/${msg.body.issue}`,
    updated_at: new Date(now).toISOString(), body: body ?? roleComment({ role: "coder", node: msg.from, kind: msg.kind, ref: `#${msg.body.issue}`, summary: `${msg.kind} for #${msg.body.issue}`,
    body: `<!-- qc:msg to=${to} ${Buffer.from(JSON.stringify(msg)).toString("base64url")} -->`, ...marker }, { secret }) };
}
const fakeReader = (comments, calls = []) => args => {
  calls.push(args);
  if (args[0] === "api" && args[1] === "user") return JSON.stringify({ login: "me" });
  assert.equal(args[0], "api");
  assert.deepEqual(args.slice(0, 2), ["api", "--paginate"]);
  assert.match(args[2], /^repos\/o\/[rst]\/issues\/comments\?per_page=100&since=/);
  assert.ok(Number.isFinite(Date.parse(new URL(`https://api.github.com/${args[2]}`).searchParams.get("since"))));
  return typeof comments === "string" ? comments : JSON.stringify(comments);
};

test("every work kind falls back after three failures, is re-signed, and posts only its hidden payload", async t => {
  for (const leader of [true]) {
    const root = fixture(t), calls = [];
    writeState(root, "node", { leader: true, term: 1 });
    const pending = kinds.map(kind => entry({ message: message({ from: "a", kind, time: new Date(now - 600_000).toISOString() }) }));
    writeState(root, "outbox", pending);
    await flushOutbox({ root, fleet, leader, clock: () => now, fetch: async () => assert.fail("no HTTP after threshold"),
      gh: args => { calls.push(args); return "posted"; } });
    assert.equal(calls.length, kinds.length);
    for (const [index, args] of calls.entries()) {
      assert.deepEqual(args.slice(0, 6), ["issue", "comment", "7", "--repo", "o/r", "--body"]);
      const body = args[6], kind = kinds[index];
      assert.ok(body.startsWith(`**${leader ? "Leader" : "Coder"}** · ${kind} for #7\n\n`));
      assert.equal(parseMarker(body, { secret, nodes: ["a", "b"], ownAuthor: true }).node, "a");
      const payload = /^<!-- qc:msg to=b ([\w-]+) -->$/m.exec(body);
      assert.ok(payload);
      assert.equal(body.split("\n\n")[1], payload[0]);
      const signed = JSON.parse(Buffer.from(payload[1], "base64url"));
      assert.deepEqual(verifyMessage(signed, { secret, nodes: fleet.nodes, now }), { ok: true });
      assert.equal(signed.id, pending[index].message.id);
      assert.equal(signed.time, new Date(now).toISOString());
      assert.deepEqual(signed.body, pending[index].message.body);
    }
    assert.deepEqual(readState(root, "outbox"), []);
  }
});

test("third failed HTTP send falls back in that tick; first two with a live peer stay on HTTP", async t => {
  const root = fixture(t), calls = [];
  let time = now;
  writeState(root, "outbox", [entry({ attempts: 1, nextAttempt: now })]);
  const opts = { root, fleet, clock: () => time, fetch: async () => { calls.push("http"); throw new Error("offline"); }, gh: () => { calls.push("github"); return "posted"; } };
  await flushOutbox(opts);
  assert.deepEqual(calls, ["http"]);
  time = readState(root, "outbox")[0].nextAttempt;
  await flushOutbox(opts);
  assert.deepEqual(calls, ["http", "http", "github"]);
  assert.deepEqual(readState(root, "outbox"), []);
});

test("heartbeat age at 90 seconds and missing heartbeat bypass retry delay; younger heartbeat does not", async t => {
  for (const age of [89_999, 90_000, 90_001, null]) {
    const root = fixture(t), calls = [];
    writeState(root, "peers", age === null ? {} : { b: { time: now - age } });
    writeState(root, "outbox", [entry({ attempts: 0 })]);
    await flushOutbox({ root, fleet, clock: () => now, gh: () => { calls.push("github"); return "posted"; }, fetch: async () => assert.fail("retry not due") });
    assert.equal(calls.length, age === 89_999 ? 0 : 1);
  }
});

test("heartbeats, election messages, and work without a positive issue never use GitHub", async t => {
  const root = fixture(t);
  const messages = ["heartbeat", "leader", "propose-leader"].map(kind => message({ kind }));
  messages.push(...[undefined, 0, -1, "7"].map(issue => message({ body: issue === undefined ? {} : { issue } })));
  writeState(root, "outbox", messages.map(message => entry({ message })));
  await flushOutbox({ root, fleet, clock: () => now, gh: () => assert.fail("not eligible"), fetch: async () => assert.fail("retry not due") });
  assert.equal(readState(root, "outbox").length, messages.length);
});

test("failed posts remain for the next tick and do not block another eligible entry or lose concurrent sends", async t => {
  for (const failure of [null, new Error("offline")]) {
    const root = fixture(t), first = entry(), second = entry(), concurrent = entry({ attempts: 0 });
    writeState(root, "outbox", [first, second]);
    let calls = 0;
    const opts = { root, fleet, clock: () => now, fetch: async () => assert.fail("GitHub owns retry"), gh: () => {
      calls++;
      if (calls === 1) {
        writeState(root, "outbox", [...readState(root, "outbox"), concurrent]);
        if (failure) throw failure;
        return failure;
      }
      return "posted";
    } };
    await flushOutbox(opts);
    assert.deepEqual(readState(root, "outbox").map(row => row.message.id), [first.message.id, concurrent.message.id]);
    await flushOutbox(opts);
    assert.equal(calls, 3);
    assert.deepEqual(readState(root, "outbox").map(row => row.message.id), [concurrent.message.id]);
  }
});

test("a receiver clock 60 seconds ahead cannot skip a comment after an empty poll", t => {
  const root = fixture(t), calls = [];
  let serverTime = now;
  const good = message({ time: new Date(now + 1000).toISOString() });
  const posted = { ...comment(good), issue_url: "https://api.github.com/repos/o/r/issues/7",
    updated_at: new Date(now + 1000).toISOString() };
  const unrelated = { user: { login: "someone-else" }, body: "ordinary comment",
    issue_url: "https://api.github.com/repos/o/r/issues/99", updated_at: new Date(now + 3000).toISOString() };
  writeState(root, "assignments", { "o/r#7": { repo: "o/r", issue: 7, node: "a" } });
  const opts = { root, fleet, repo: "o/r", clock: () => serverTime + 60_000, gh: args => {
    calls.push(args);
    if (args[1] === "user") return JSON.stringify({ login: "me" });
    const endpoint = args.find(arg => arg.startsWith("repos/"));
    const since = new URL(`https://api.github.com/${endpoint}`).searchParams.get("since")
      ?? args.find(arg => arg.startsWith("since="))?.slice(6);
    return JSON.stringify([posted, unrelated].filter(row => Date.parse(row.updated_at) <= serverTime && Date.parse(row.updated_at) >= Date.parse(since)));
  } };
  readGithub(opts);
  serverTime += 1000;
  readGithub(opts);
  assert.deepEqual(readState(root, "queue"), [good], "the empty poll must not advance past the next GitHub comment");
  assert.equal(readState(root, "github").cursors["o/r"], new Date(now - 59_000).toISOString());
  assert.deepEqual(calls.filter(args => args[1] !== "user").map(args => args.find(arg => arg.startsWith("repos/"))), [
    `repos/o/r/issues/comments?per_page=100&since=${new Date(now - 540_000).toISOString()}`,
    `repos/o/r/issues/comments?per_page=100&since=${new Date(now - 539_000).toISOString()}`,
  ]);
  serverTime += 2000;
  readGithub(opts);
  assert.equal(readState(root, "github").cursors["o/r"], new Date(now - 57_000).toISOString());
  assert.deepEqual(readState(root, "queue"), [good], "overlapping reads silently discard seen IDs");
  const saved = readState(root, "github");
  readGithub({ ...opts, gh: fakeReader([]) });
  assert.deepEqual(readState(root, "github"), saved, "an empty read preserves the cursor");
  readGithub({ ...opts, gh: args => { if (args[1] === "user") return JSON.stringify({ login: "me" }); throw new Error("offline"); } });
  assert.deepEqual(readState(root, "github"), saved, "a gh error preserves the cursor");
});

test("GitHub reads the serve repository and every assigned repository once with durable repository cursors", t => {
  const root = fixture(t), calls = [];
  writeState(root, "assignments", {
    "o/r#7": { repo: "o/r", issue: 7, node: "a" }, "o/r#8": { repo: "o/r", issue: 8, node: "b" },
    "o/s#9": { repo: "o/s", issue: 9, node: "a" },
    "o/t#10": { repo: "o/t", issue: 10, node: "b" },
  });
  const opts = { root, fleet, repo: "o/r", clock: () => now, gh: fakeReader([comment()], calls) };
  readGithub(opts);
  const reads = calls.filter(args => args[1] !== "user");
  assert.deepEqual(reads.map(args => args[2].split("?")[0]), ["repos/o/r/issues/comments", "repos/o/s/issues/comments", "repos/o/t/issues/comments"]);
  assert.deepEqual(readState(root, "queue").map(msg => msg.id).length, 1, "comments must match their repository");
  assert.deepEqual(readState(root, "github").cursors, Object.fromEntries(["o/r", "o/s", "o/t"].map(repo => [repo, new Date(now - 60_000).toISOString()])));
  calls.length = 0;
  readGithub({ ...opts, clock: () => now + 120_000 });
  assert.ok(calls.filter(args => args[1] !== "user").every(args => args[2].endsWith(`since=${new Date(now - 60_000).toISOString()}`)));
});

test("GitHub compares repository names without case", t => {
  for (const repo of ["acme/repo", "Acme/Repo"]) {
    const root = fixture(t), calls = [];
    const good = message({ repo });
    const posted = { ...comment(good), issue_url: "https://api.github.com/repos/Acme/Repo/issues/7" };
    writeState(root, "assignments", { "Acme/Repo#7": { repo: "Acme/Repo", issue: 7, node: "a" } });
    readGithub({ root, fleet, repo: "acme/repo", clock: () => now, gh: args => {
      calls.push(args);
      if (args[1] === "user") return JSON.stringify({ login: "me" });
      return JSON.stringify([posted]);
    } });
    assert.deepEqual(readState(root, "queue"), [good], "the repository casing must not drop authenticated work");
    assert.equal(calls.filter(args => args[1] !== "user").length, 1, "repository casing must not cause duplicate reads");
  }
});

test("GitHub accepts only own authenticated addressed work, and shares HTTP signature, sender, time and replay checks", async t => {
  const root = fixture(t);
  writeState(root, "assignments", { "o/r#7": { repo: "o/r", issue: 7, node: "a" } });
  const good = message(), httpFirst = message();
  assert.deepEqual(receiveMessage({ root, fleet, message: httpFirst, clock: () => now }), { ok: true });
  const badSignature = message(); badSignature.sig = "00".repeat(32);
  const invalid = [
    comment(message(), { author: "someone-else" }), comment(message(), { to: "b" }),
    comment(message(), { body: "<!-- qc:msg to=a garbage -->" }),
    comment(message(), { marker: { node: "a" } }),
    comment(badSignature), comment(message({ from: "unknown" }), { marker: { node: "b" } }),
    comment(message({ time: new Date(now - 300_001).toISOString() })), comment(httpFirst),
    comment(message({ kind: "leader" })), comment(message({ kind: "heartbeat" })),
    comment(message(), { marker: { ref: "#8" } }),
    { ...comment(message({ repo: "o/s" })), issue_url: "https://api.github.com/repos/o/r/issues/7" },
    { ...comment(message()), issue_url: "https://api.github.com/repos/o/r/issues/8" },
    { ...comment(message()), issue_url: "invalid" },
    { ...comment(message()), issue_url: "https://api.github.com/repos/o/s/issues/7" },
    comment(message(), { body: comment().body.replace(/sig=./, "sig=z") }),
  ];
  const malformed = roleComment({ role: "coder", node: "b", kind: "question", ref: "#7", summary: "question for #7", body: "<!-- qc:msg to=a eA -->" }, { secret });
  readGithub({ root, fleet, clock: () => now, gh: fakeReader([...invalid, comment(message(), { body: malformed }), comment(good), comment(good)]) });
  assert.deepEqual(readState(root, "queue"), [httpFirst, good]);
  const server = await createNodeServer({ root, fleet, clock: () => now, listen: { port: 0 } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/message`, { method: "POST", body: JSON.stringify(good) });
  assert.equal((await response.json()).reason, "seen-id");
});

test("paginated comments are read and gh errors or invalid responses preserve each read cursor", t => {
  const root = fixture(t), cursor = new Date(now - 120_000).toISOString();
  writeState(root, "assignments", { "o/r#7": { repo: "o/r", issue: 7, node: "a" } });
  for (const result of [null, "bad-json", "{}", new Error("offline")]) {
    writeState(root, "github", { cursors: { "o/r": cursor } });
    readGithub({ root, fleet, clock: () => now, gh: args => {
      if (args[1] === "user") return JSON.stringify({ login: "me" });
      if (result instanceof Error) throw result;
      return result;
    } });
    assert.equal(readState(root, "github").cursors["o/r"], cursor);
  }
  const good = message();
  readGithub({ root, fleet, clock: () => now, gh: fakeReader(`[]\n${JSON.stringify([comment(good)])}`) });
  assert.deepEqual(readState(root, "queue"), [good]);
  const saved = readState(root, "github");
  readGithub({ root, fleet, clock: () => now + 120_000, gh: () => { throw new Error("user read failed"); } });
  assert.deepEqual(readState(root, "github"), saved);
});
