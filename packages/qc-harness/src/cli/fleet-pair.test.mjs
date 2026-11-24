import { strict as assert } from "node:assert";
import { createHash, createPublicKey, createPrivateKey, diffieHellman, hkdfSync, createDecipheriv } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { stateDir } from "./fleet-state.mjs";
import { createKey, pairCode, pairDigest, pairCommit, createPairing, pairingDecision, readPairing } from "./fleet-pair.mjs";

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
  const root = fixture(t), other = fixture(t), sent = [], reveals = [];
  const lead = createPairing({ root, fleet: a, leader: () => true, address: "192.168.1.10", clock: () => time,
    fetch: async (url, options) => { sent.push(JSON.parse(options.body)); return { status: 202 }; } });
  const join = createPairing({ root: other, fleet: b, address: "192.168.1.20", clock: () => time,
    fetch: async (_url, options) => { const body = JSON.parse(options.body); reveals.push(body); return { status: lead.receivePair(body, "192.168.1.20") ? 202 : 400 }; },
    saveSecret: value => { saved = value; } });
  return { a, b, root, other, lead, join, sent, reveals, get saved() { return saved; }, advance: ms => { time += ms; } };
}
async function offer(p) {
  assert.equal(p.lead.receiveJoin(p.join.beacon(), "192.168.1.20"), true);
  await p.lead.tick();
  assert.equal(p.sent.at(-1).kind, "offer");
  p.offerNonce = p.sent.at(-1).nonce;
  assert.equal(p.join.receivePair(p.sent.at(-1), "192.168.1.10"), true);
  return readPairing(p.root).requests.joiner.code;
}

test("digest binds ordered raw keys and ordered 16-byte random values; code uses its first six bytes", () => {
  const a = createKey(), b = createKey(), lr = "11".repeat(16), r = "22".repeat(16);
  const raw = key => Buffer.from(createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" }).export({ format: "jwk" }).x, "base64url");
  const expected = createHash("sha256").update(Buffer.concat([Buffer.from("qc-fleet-pair\n"), raw(a.public), raw(b.public), Buffer.from(lr, "hex"), Buffer.from(r, "hex")])).digest();
  assert.deepEqual(pairDigest(a.public, b.public, lr, r), expected);
  assert.equal(pairCode(a.public, b.public, lr, r), String(expected.readUIntBE(0, 6) % 1_000_000).padStart(6, "0"));
  assert.notDeepEqual(pairDigest(b.public, a.public, lr, r), expected);
  assert.notDeepEqual(pairDigest(a.public, b.public, r, lr), expected);
  assert.throws(() => pairCode(a.public, "bad", lr, r));
  assert.throws(() => pairDigest(a.public, b.public, lr, "00"));
  assert.equal(pairCommit(b.public, r), createHash("sha256").update(Buffer.concat([Buffer.from("qc-fleet-commit\n"), raw(b.public), Buffer.from(r, "hex")])).digest("hex"));
});

test("beacon commits once per attempt and reveals only after an offer; wrong reveals are refused", async t => {
  const p = peers(t), beacon = p.join.beacon();
  assert.match(beacon.commit, /^[0-9a-f]{64}$/);
  assert.equal(beacon.pub, undefined);
  assert.equal(beacon.nonce, undefined);
  p.advance(1000);
  assert.equal(p.join.beacon().commit, beacon.commit);
  const restarted = createPairing({ fleet: p.b, address: "192.168.1.20" });
  assert.notEqual(restarted.beacon().commit, beacon.commit);
  assert.equal(p.reveals.length, 0);
  assert.equal(p.lead.receiveJoin(beacon, "192.168.1.20"), true);
  assert.equal(readPairing(p.root).requests.joiner.code, undefined);
  assert.equal(p.lead.receivePair({ kind: "reveal", id: "joiner", pub: p.b.key.public, nonce: "00".repeat(16) }, "192.168.1.20"), false);
  assert.equal(readPairing(p.root).requests.joiner.code, undefined);
  await p.lead.tick();
  assert.equal(p.sent[0].commit, beacon.commit);
  assert.match(p.sent[0].nonce, /^[0-9a-f]{32}$/);
  assert.equal(p.join.receivePair(p.sent[0], "192.168.1.10"), true);
  assert.equal(p.reveals.length, 1);
  const reveal = p.reveals[0];
  assert.deepEqual(Object.keys(reveal).sort(), ["id", "kind", "nonce", "pub"]);
  assert.equal(pairCommit(reveal.pub, reveal.nonce), beacon.commit);
  assert.equal(p.lead.receivePair({ ...reveal, nonce: "ff".repeat(16) }, "192.168.1.20"), false);
  assert.equal(p.lead.receivePair(reveal, "192.168.1.30"), false);
  assert.equal(p.lead.receivePair({ ...reveal, extra: true }, "192.168.1.20"), false);
  assert.equal(readPairing(p.root).requests.joiner.code, readPairing(p.other).offers.leader.code);
});

test("after revealing, the joiner ignores offers from every other Leader id", async t => {
  const p = peers(t);
  await offer(p);
  const first = readPairing(p.other).offers.leader, reveal = p.reveals[0];
  const second = { ...p.sent[0], leader: "fake-leader", pub: createKey().public };
  assert.equal(p.join.receivePair(second, "192.168.1.30"), false);
  assert.equal(p.reveals.length, 1);
  p.advance(15_000);
  await p.join.tick();
  assert.deepEqual(p.reveals, [reveal, reveal]);
  assert.deepEqual(readPairing(p.other).offers, { leader: first });
});

test("expiry rotates the attempt's random value and commitment before any new reveal", async t => {
  const p = peers(t), beacon = p.join.beacon();
  await offer(p);
  const oldReveal = p.reveals[0], oldOffer = p.sent[0];
  p.advance(600_001);
  await p.join.tick();
  assert.equal(p.reveals.length, 1);
  const next = p.join.beacon();
  assert.notEqual(next.commit, beacon.commit);
  assert.equal(p.join.beacon().commit, next.commit);
  assert.deepEqual(readPairing(p.other).offers, {});
  assert.equal(p.join.receivePair({ ...oldOffer, time: now + 600_001 }, "192.168.1.10"), false);
  assert.deepEqual(readPairing(p.other).offers, {});
  assert.equal(p.reveals.length, 1);
  assert.equal(p.lead.receiveJoin(next, "192.168.1.20"), true);
  await p.lead.tick();
  assert.equal(p.join.receivePair(p.sent.at(-1), "192.168.1.10"), true);
  assert.equal(p.reveals.length, 2);
  assert.notEqual(p.reveals[1].nonce, oldReveal.nonce);
  assert.equal(pairCommit(p.reveals[1].pub, p.reveals[1].nonce), next.commit);
});

test("joiner deny drops its offer and rotates the attempt without revealing old randomness", async t => {
  const p = peers(t), beacon = p.join.beacon(), code = await offer(p);
  const oldReveal = p.reveals[0];
  pairingDecision(p.root, "allow", code, now);
  await p.lead.tick();
  const grant = p.sent.find(body => body.kind === "grant");
  assert.equal(p.join.receivePair(grant, "192.168.1.10"), true);
  pairingDecision(p.other, "accept", code, now);
  pairingDecision(p.other, "deny", code, now, { joiner: true });
  assert.deepEqual(readPairing(p.other).offers, {});
  assert.throws(() => pairingDecision(p.other, "accept", code, now));
  await p.join.tick();
  assert.equal(p.saved, undefined);
  assert.equal(p.join.receivePair(grant, "192.168.1.10"), false);
  assert.equal(p.reveals.length, 1);
  const next = p.join.beacon();
  assert.notEqual(next.commit, beacon.commit);
  assert.equal(p.join.receivePair({ ...p.sent[0], leader: "other-leader", commit: next.commit }, "192.168.1.30"), true);
  assert.notEqual(p.reveals[1].nonce, oldReveal.nonce);
  assert.equal(pairCommit(p.reveals[1].pub, p.reveals[1].nonce), next.commit);
  assert.equal(readPairing(p.other).offers["other-leader"].accepted, false);
});

test("retry with the same Leader after joiner deny waits for the old request to expire and pairs with matching codes", async t => {
  const p = peers(t), code = await offer(p), oldOffer = p.sent[0];
  p.advance(15_000);
  pairingDecision(p.other, "deny", code, now + 15_000, { joiner: true });
  const next = p.join.beacon();
  assert.notEqual(next.commit, oldOffer.commit);
  assert.equal(p.lead.receiveJoin(next, "192.168.1.20"), false);
  await p.lead.tick();
  const retry = p.sent.at(-1);
  assert.equal(retry.commit, oldOffer.commit);
  assert.equal(p.join.receivePair(retry, "192.168.1.10"), false);
  assert.deepEqual(readPairing(p.other).offers, {});
  assert.equal(p.reveals.length, 1);
  assert.equal(readPairing(p.root).requests.joiner.code, code);
  p.advance(585_001);
  assert.equal(p.join.beacon().commit, next.commit);
  const nextCode = await offer(p);
  assert.equal(p.sent.at(-1).commit, next.commit);
  assert.equal(readPairing(p.other).offers.leader.code, nextCode);
  pairingDecision(p.root, "allow", nextCode, now + 600_001);
  pairingDecision(p.other, "accept", nextCode, now + 600_001);
  await p.lead.tick();
  const grant = p.sent.find(body => body.kind === "grant");
  assert.ok(grant);
  assert.equal(p.join.receivePair(grant, "192.168.1.10"), true);
  await p.join.tick();
  assert.equal(p.saved, secret);
});

test("restart retains the active Leader binding and observes another process denying it", async t => {
  const p = peers(t), beacon = p.join.beacon(), code = await offer(p), reveals = [];
  const restarted = createPairing({ root: p.other, fleet: p.b, address: "192.168.1.20", clock: () => now,
    fetch: async (_url, options) => { reveals.push(JSON.parse(options.body)); } });
  assert.equal(restarted.beacon().commit, beacon.commit);
  assert.equal(restarted.receivePair({ ...p.sent[0], leader: "other-leader" }, "192.168.1.30"), false);
  await restarted.tick();
  assert.deepEqual(reveals, [p.reveals[0]]);
  pairingDecision(p.other, "deny", code, now, { joiner: true });
  await restarted.tick();
  assert.equal(reveals.length, 1);
  const next = restarted.beacon();
  assert.notEqual(next.commit, beacon.commit);
  assert.equal(p.join.beacon().commit, next.commit);
  assert.equal(restarted.receivePair(p.sent[0], "192.168.1.10"), false);
  assert.equal(reveals.length, 1);
  assert.equal(restarted.receivePair({ ...p.sent[0], commit: next.commit }, "192.168.1.10"), true);
  assert.notEqual(reveals[1].nonce, p.reveals[0].nonce);
  assert.equal(pairCommit(reveals[1].pub, reveals[1].nonce), next.commit);
});

test("bad public keys reach parsing before an offer is bound", t => {
  const p = peers(t);
  const body = { kind: "offer", leader: "unused-leader", commit: p.join.beacon().commit, pub: "bad", nonce: "11".repeat(16), port: 8080, time: now };
  assert.equal(p.join.receivePair(body, "192.168.1.10"), false);
  assert.deepEqual(readPairing(p.other).offers, {});
  assert.equal(p.reveals.length, 0);
  assert.equal(p.join.receivePair({ ...body, pub: p.a.key.public }, "192.168.1.10"), true);
  assert.equal(p.reveals.length, 1);
});

test("offers without the active commitment cannot bind any Leader", t => {
  const p = peers(t), beacon = p.join.beacon();
  const body = { kind: "offer", leader: "leader", pub: p.a.key.public, nonce: "11".repeat(16), port: 8080, time: now };
  for (const commit of [undefined, null, "bad", "00".repeat(32)]) {
    assert.equal(p.join.receivePair({ ...body, commit }, "192.168.1.10"), false);
    assert.deepEqual(readPairing(p.other).offers, {});
    assert.equal(p.reveals.length, 0);
  }
  assert.equal(p.join.receivePair({ ...body, commit: beacon.commit }, "192.168.1.10"), true);
  assert.equal(p.reveals.length, 1);
});

test("first commitment and offer stay fixed through retries until expiry", async t => {
  const p = peers(t), beacon = p.join.beacon();
  p.lead.receiveJoin(beacon, "192.168.1.20");
  const first = readPairing(p.root).requests.joiner;
  p.advance(15_000);
  assert.equal(p.lead.receiveJoin({ ...beacon, commit: "11".repeat(32), port: 9090, time: now + 15_000 }, "192.168.1.20"), false);
  assert.deepEqual(readPairing(p.root).requests.joiner, first);
  await p.lead.tick();
  const body = p.sent[0];
  assert.equal(p.join.receivePair(body, "192.168.1.10"), true);
  const original = readPairing(p.other).offers.leader;
  pairingDecision(p.other, "accept", original.code, now + 15_000);
  p.advance(15_000);
  for (const change of [{ pub: createKey().public }, { nonce: "33".repeat(16) }, { port: 9090 }, {}])
    assert.equal(p.join.receivePair({ ...body, ...change, time: now + 30_000 }, "192.168.1.10"), false);
  assert.deepEqual(readPairing(p.other).offers.leader, { ...original, accepted: true });
  assert.equal(p.lead.receiveJoin({ ...beacon, time: now + 30_000 }, "192.168.1.20"), false);
  p.advance(600_001);
  assert.equal(p.lead.receiveJoin(p.join.beacon(), "192.168.1.20"), true);
  await p.lead.tick();
  assert.notEqual(p.sent.at(-1).nonce, body.nonce);
  assert.equal(p.join.receivePair(p.sent.at(-1), "192.168.1.10"), true);
  assert.equal(readPairing(p.other).offers.leader.accepted, false);
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
  const reveal = p.reveals[0], digest = pairDigest(p.a.key.public, p.b.key.public, p.offerNonce, reveal.nonce);
  const shared = diffieHellman({ privateKey: createPrivateKey({ key: Buffer.from(p.b.key.private, "base64"), format: "der", type: "pkcs8" }), publicKey: createPublicKey({ key: Buffer.from(p.a.key.public, "base64"), format: "der", type: "spki" }) });
  const decipher = createDecipheriv("aes-256-gcm", hkdfSync("sha256", shared, digest, Buffer.from("qc-fleet-pair"), 32), Buffer.from(grant.nonce, "base64"));
  const data = Buffer.from(grant.data, "base64");
  decipher.setAuthTag(data.subarray(-16));
  assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString()), { secret });
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
  assert.throws(() => pairingDecision(p.root, "allow", code, now + 4_200_002));
});

test("join validation rejects bad fields, stale clocks, spoofed senders and oversized datagrams; requests cap at 20", async t => {
  const p = peers(t), beacon = p.join.beacon();
  for (const change of [{ v: 2 }, { id: "../bad" }, { commit: "bad" }, { port: 0 }, { hostname: "x\n" },
    { os: {} }, { time: now - 60_001 }, { address: "192.168.1.30" }, { commit: "00".repeat(31) }, { extra: "x".repeat(2048) }]) {
    assert.equal(p.lead.receiveJoin({ ...beacon, ...change }, "192.168.1.20"), false);
  }
  for (let i = 0; i < 21; i++) p.lead.receiveJoin({ ...beacon, id: `pc-${i}` }, "192.168.1.20");
  assert.equal(Object.keys(readPairing(p.root).requests).length, 20);
  assert.ok(readPairing(p.root).requests["pc-0"]);
  assert.equal(readPairing(p.root).requests["pc-20"], undefined);
  p.advance(600_001);
  assert.equal(p.lead.receiveJoin(p.join.beacon(), "192.168.1.20"), true);
  assert.equal(Object.keys(readPairing(p.root).requests).length, 1);
});

test("offers and grants bind sender, key and live offer; retries expire and stop on a signed beacon", async t => {
  const p = peers(t), code = await offer(p), body = p.sent[0];
  for (const change of [{ time: now - 60_001 }, { port: 0 }, { pub: "bad", leader: "unused-leader" }, { leader: "../bad" }, { extra: "x".repeat(2048) }])
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


test("shared contract flags drive grant and accept across a restart; retries cannot extend request lifetime", async t => {
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
  // Repeated beacons cannot extend the fixed request or its grant window.
  delete p.b.secret;
  p.advance(600_001);
  p.sent.length = 0;
  await p.lead.tick();
  assert.equal(p.sent.length, 0);
  assert.throws(() => pairingDecision(p.root, "allow", code, now + 600_001));
});

test("second-subnet offer source receives reveal and completes bound pairing", async t => {
  const primary = "192.168.1.220", secondary = "192.168.100.10", sender = "192.168.100.20";
  for (const first of ["allow", "accept"]) {
    const root = fixture(t), other = fixture(t), sent = [], reveals = [];
    let time = now, saved;
    const a = { self: "leader", secret, key: createKey(), discover: true,
      nodes: [{ id: "leader", address: primary, port: 8080 }] };
    const b = { self: "joiner", key: createKey(), discover: true,
      nodes: [{ id: "joiner", address: sender, port: 8081 }] };
    const lead = createPairing({ root, fleet: a, address: primary, leader: () => true, clock: () => time,
      fetch: async (url, options) => { sent.push({ url, body: JSON.parse(options.body) }); return { status: 202 }; } });
    const join = createPairing({ root: other, fleet: b, address: sender, clock: () => time, saveSecret: value => { saved = value; },
      fetch: async (url, options) => {
        const body = JSON.parse(options.body);
        reveals.push({ url, body });
        assert.equal(url, `http://${secondary}:8080/pair`);
        assert.equal(lead.receivePair(body, sender), true);
        return { status: 202 };
      } });
    const beacon = join.beacon();
    assert.equal(lead.receiveJoin(beacon, sender), true);
    assert.equal(readPairing(root).requests.joiner.code, undefined);
    assert.throws(() => pairingDecision(root, "allow", "000000", time));
    await lead.tick();
    const offer = sent[0].body;
    assert.equal(sent[0].url, `http://${sender}:8081/pair`);
    for (const invalid of [{ ...offer, commit: "00".repeat(32) }, { ...offer, pub: "bad" }]) {
      assert.equal(join.receivePair(invalid, secondary), false);
    }
    assert.equal(reveals.length, 0);
    // Routing selects the Leader's secondary source, which becomes the reveal destination.
    assert.equal(join.receivePair(offer, secondary), true);
    assert.equal(reveals.length, 1);
    const reveal = reveals[0].body;
    assert.equal(pairCommit(reveal.pub, reveal.nonce), beacon.commit);
    const code = readPairing(root).requests.joiner.code;
    assert.match(code, /^\d{6}$/);
    assert.equal(code, readPairing(other).offers.leader.code);
    assert.equal(readPairing(other).offers.leader.address, secondary);
    assert.equal(lead.receivePair(reveal, "192.168.100.99"), false);
    assert.equal(lead.receivePair({ ...reveal, pub: createKey().public }, sender), false);
    assert.equal(lead.receivePair({ ...reveal, nonce: "ff".repeat(16) }, sender), false);
    assert.equal(join.receivePair({ ...offer, leader: "other-leader" }, primary), false);
    assert.equal(join.receivePair({ ...offer, pub: createKey().public }, primary), false);
    assert.equal(reveals.length, 1);
    assert.deepEqual(Object.keys(readPairing(other).offers), ["leader"]);

    pairingDecision(first === "allow" ? root : other, first, code, time);
    await lead.tick();
    const earlyGrant = sent.find(row => row.body.kind === "grant")?.body;
    if (first === "allow") {
      assert.ok(earlyGrant);
      assert.equal(join.receivePair(earlyGrant, secondary), true);
    } else assert.equal(earlyGrant, undefined);
    await join.tick();
    assert.equal(saved, undefined, `${first} alone must not install a secret`);
    assert.equal(b.secret, undefined);

    pairingDecision(first === "allow" ? other : root, first === "allow" ? "accept" : "allow", code, time);
    time += 15_000;
    await lead.tick();
    const grant = sent.findLast(row => row.body.kind === "grant").body;
    assert.equal(join.receivePair(grant, primary), false);
    assert.equal(join.receivePair({ ...grant, pub: createKey().public }, secondary), false);
    const corrupted = Buffer.from(grant.data, "base64");
    corrupted[0] ^= 1;
    assert.equal(join.receivePair({ ...grant, data: corrupted.toString("base64") }, secondary), false);
    assert.equal(join.receivePair(grant, secondary), true);
    await join.tick();
    assert.equal(saved, secret);
    assert.equal(b.secret, secret);
  }
});
