import { strict as assert } from "node:assert";
import { createHash, createPublicKey } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { stateDir } from "./fleet-state.mjs";
import { createKey, pairCode, createPairing, pairingDecision, readPairing } from "./fleet-pair.mjs";

const now = 1_800_000_000_000;
const secret = "ab".repeat(32);
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-pair-"));
  mkdirSync(path.join(root, ".git"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}
function peers(t) {
  let time = now, saved;
  const a = { self: "leader", key: createKey(), secret, nodes: [{ id: "leader", port: 8080 }] };
  const b = { self: "joiner", key: createKey(), nodes: [{ id: "joiner", port: 8081 }] };
  const root = fixture(t), other = fixture(t), sent = [];
  const lead = createPairing({ root, fleet: a, leader: () => true, address: "192.168.1.10", clock: () => time,
    fetch: async (url, options) => { sent.push(JSON.parse(options.body)); return { status: 202 }; } });
  const join = createPairing({ root: other, fleet: b, address: "192.168.1.20", clock: () => time,
    saveSecret: value => { saved = value; } });
  return { a, b, root, other, lead, join, sent, get saved() { return saved; }, advance: ms => { time += ms; } };
}
async function offer(p) {
  assert.equal(p.lead.receiveJoin(p.join.beacon(), "192.168.1.20"), true);
  await p.lead.tick();
  assert.equal(p.sent.at(-1).kind, "offer");
  assert.equal(p.join.receivePair(p.sent.at(-1), "192.168.1.10"), true);
  return pairCode(p.a.key.public, p.b.key.public);
}

test("code uses sorted raw X25519 keys and changes with a MITM key", () => {
  const a = createKey(), b = createKey(), mitm = createKey();
  const raw = key => Buffer.from(createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" }).export({ format: "jwk" }).x, "base64url");
  const expected = String(createHash("sha256").update(Buffer.concat([Buffer.from("qc-fleet-pair\n"), ...[raw(a.public), raw(b.public)].sort(Buffer.compare)])).digest().readUIntBE(0, 6) % 1_000_000).padStart(6, "0");
  assert.equal(pairCode(a.public, b.public), expected);
  assert.equal(pairCode(b.public, a.public), expected);
  assert.notEqual(pairCode(a.public, mitm.public), expected);
  assert.throws(() => pairCode(a.public, "bad"));
});

test("grant waits for accept, authenticates its tag, then saves the shared secret", async t => {
  const p = peers(t), code = await offer(p);
  assert.deepEqual(readPairing(p.root).requests.joiner, { code, address: "192.168.1.20", port: 8081,
    hostname: os.hostname(), os: process.platform, seen: now, allowed: false });
  assert.equal(readPairing(p.other).offers.leader.code, code);
  pairingDecision(p.root, "allow", code, now);
  p.sent.length = 0;
  await p.lead.tick();
  const grant = p.sent.find(body => body.kind === "grant");
  assert.ok(grant);
  assert.equal(JSON.stringify(grant).includes(secret), false);
  const damaged = { ...grant, data: Buffer.alloc(Buffer.from(grant.data, "base64").length).toString("base64") };
  assert.equal(p.join.receivePair(damaged, "192.168.1.10"), false);
  assert.equal(p.join.receivePair(grant, "192.168.1.10"), true);
  await p.join.tick();
  assert.equal(p.saved, undefined);
  pairingDecision(p.other, "accept", code, now);
  await p.join.tick();
  assert.equal(p.saved, secret);
});

test("deny blocks the same id and key for one hour and rejects ambiguous or expired codes", async t => {
  const p = peers(t), code = await offer(p);
  pairingDecision(p.root, "deny", code, now);
  assert.equal(p.lead.receiveJoin(p.join.beacon(), "192.168.1.20"), false);
  const changedId = { ...p.join.beacon(), id: "renamed" };
  assert.equal(p.lead.receiveJoin(changedId, "192.168.1.20"), false);
  p.b.key = createKey();
  assert.equal(p.lead.receiveJoin(p.join.beacon(), "192.168.1.20"), false);
  assert.throws(() => pairingDecision(p.root, "allow", code, now));
  p.advance(3_600_001);
  assert.equal(p.lead.receiveJoin(p.join.beacon(), "192.168.1.20"), true);
  p.advance(600_001);
  assert.throws(() => pairingDecision(p.root, "allow", pairCode(p.a.key.public, p.b.key.public), now + 4_200_002));
});

test("join validation rejects bad fields, stale clocks, spoofed senders and oversized datagrams; requests cap at 20", async t => {
  const p = peers(t), beacon = p.join.beacon();
  for (const change of [{ v: 2 }, { id: "../bad" }, { pub: "bad" }, { port: 0 }, { hostname: "x\n" },
    { os: {} }, { time: now - 60_001 }, { address: "192.168.1.30" }, { nonce: "" }, { extra: "x".repeat(2048) }]) {
    assert.equal(p.lead.receiveJoin({ ...beacon, ...change }, "192.168.1.20"), false);
  }
  for (let i = 0; i < 21; i++) p.lead.receiveJoin({ ...beacon, id: `pc-${i}` }, "192.168.1.20");
  assert.equal(Object.keys(readPairing(p.root).requests).length, 20);
  p.advance(600_001);
  assert.equal(p.lead.receiveJoin(p.join.beacon(), "192.168.1.20"), true);
  assert.equal(Object.keys(readPairing(p.root).requests).length, 1);
});

test("offers and grants bind sender, key and live offer; retries expire and stop on a signed beacon", async t => {
  const p = peers(t), code = await offer(p), body = p.sent[0];
  for (const change of [{ time: now - 60_001 }, { port: 0 }, { pub: "bad" }, { leader: "../bad" }, { extra: "x".repeat(2048) }])
    assert.equal(p.join.receivePair({ ...body, ...change }, "192.168.1.10"), false);
  pairingDecision(p.root, "allow", code, now);
  p.sent.length = 0;
  await p.lead.tick();
  const grant = p.sent.find(body => body.kind === "grant");
  assert.equal(p.join.receivePair(grant, "192.168.1.30"), false);
  assert.equal(p.join.receivePair({ ...grant, pub: createKey().public }, "192.168.1.10"), false);
  p.advance(15_000);
  await p.lead.tick();
  assert.equal(p.sent.filter(body => body.kind === "grant").length, 2);
  p.lead.signed("joiner");
  p.advance(15_000);
  await p.lead.tick();
  assert.equal(p.sent.filter(body => body.kind === "grant").length, 2);
  const q = peers(t), qcode = await offer(q);
  pairingDecision(q.root, "allow", qcode, now);
  await q.lead.tick();
  const old = q.sent.find(body => body.kind === "grant");
  assert.equal(q.join.receivePair(old, "192.168.1.10"), true);
  q.advance(600_001);
  q.sent.length = 0;
  await q.lead.tick();
  assert.equal(q.sent.length, 0);
  assert.equal(q.join.receivePair(old, "192.168.1.10"), false);
  assert.throws(() => pairingDecision(q.other, "accept", qcode, now + 600_001));
});


test("shared contract flags drive grant and accept across a restart; reallow renews an expired grant window", async t => {
  const p = peers(t), code = await offer(p);
  const file = path.join(stateDir(p.root), "pairing.json"), state = readPairing(p.root);
  state.requests.joiner.allowed = "true";
  writeFileSync(file, JSON.stringify(state));
  await p.lead.tick();
  assert.equal(p.sent.some(body => body.kind === "grant"), false);
  state.requests.joiner.allowed = true;
  writeFileSync(file, JSON.stringify(state));
  await p.lead.tick();
  let grant = p.sent.find(body => body.kind === "grant");
  assert.ok(grant);
  assert.equal(p.join.receivePair(grant, "192.168.1.10"), true);
  const offers = readPairing(p.other);
  offers.offers.leader.accepted = "true";
  writeFileSync(path.join(stateDir(p.other), "pairing.json"), JSON.stringify(offers));
  let saved;
  const restarted = createPairing({ root: p.other, fleet: p.b, clock: () => now, saveSecret: value => { saved = value; } });
  await restarted.tick();
  assert.equal(saved, undefined);
  offers.offers.leader.accepted = true;
  writeFileSync(path.join(stateDir(p.other), "pairing.json"), JSON.stringify(offers));
  await createPairing({ root: p.other, fleet: p.b, clock: () => now, saveSecret: value => { saved = value; } }).tick();
  assert.equal(saved, secret);
  assert.equal(readFileSync(path.join(stateDir(p.other), "pairing-private.json"), "utf8").includes(secret), false);
  // A fresh join keeps the request live, but cannot extend the ten-minute grant window.
  delete p.b.secret;
  p.advance(300_000);
  p.lead.receiveJoin(p.join.beacon(), "192.168.1.20");
  await p.lead.tick();
  p.advance(300_001);
  p.lead.receiveJoin(p.join.beacon(), "192.168.1.20");
  p.sent.length = 0;
  await p.lead.tick();
  assert.equal(p.sent.some(body => body.kind === "grant"), false);
  pairingDecision(p.root, "allow", code, now + 600_001);
  p.advance(15_000);
  await p.lead.tick();
  grant = p.sent.find(body => body.kind === "grant");
  assert.ok(grant);
});
