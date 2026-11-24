import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { KINDS, canonical, createMessage, verifyMessage } from "./fleet-message.mjs";

const secret = "ab".repeat(32);
const now = Date.parse("2026-11-24T12:00:00Z");
const fields = { id: "message-1", kind: "assign", repo: "owner/name", from: "a1", time: new Date(now).toISOString(), body: { number: 238 } };
const options = () => ({ secret, nodes: [{ id: "a1" }], seen: {}, now });
const signed = changes => createMessage({ ...fields, ...changes }, secret);

test("canonical JSON sorts recursively and signatures cover all unsigned fields", () => {
  assert.equal(canonical({ z: [{ b: 2, a: 1 }], a: { z: null, a: true } }), '{"a":{"a":true,"z":null},"z":[{"a":1,"b":2}]}');
  assert.equal(canonical(JSON.parse('{"__proto__":{"z":1},"b":2}')), '{"__proto__":{"z":1},"b":2}');
  const message = signed({ body: { z: 1, a: { d: 2, c: 3 } }, extra: "covered" });
  const { sig, ...unsigned } = message;
  assert.equal(sig, createHmac("sha256", secret).update(canonical(unsigned)).digest("hex"));
  for (const key of Object.keys(unsigned)) {
    assert.deepEqual(verifyMessage({ ...message, [key]: "tampered" }, options()), { ok: false, reason: key === "body" ? "bad-body" : "bad-signature" });
  }
});

test("good messages accept every fixed kind, keep command text inert, and reject replays", () => {
  assert.deepEqual(KINDS, ["assign", "plan", "approve", "question", "answer", "pushed", "verdict", "platform-check", "platform-result", "heartbeat", "propose-leader", "leader"]);
  for (const kind of KINDS) assert.deepEqual(verifyMessage(signed({ kind, body: { command: "do not execute" } }), options()), { ok: true });
  const context = options();
  const message = signed();
  assert.deepEqual(verifyMessage(message, context), { ok: true });
  assert.equal(context.seen[message.id], now);
  assert.deepEqual(verifyMessage(message, context), { ok: false, reason: "seen-id" });
  const generated = createMessage({ kind: "heartbeat", repo: "owner/name", from: "a1", body: {} }, secret);
  assert.equal(generated.v, 1);
  assert.ok(generated.id);
  assert.ok(Number.isFinite(Date.parse(generated.time)));
  for (const key of ["a".repeat(65), "AB".repeat(40)]) {
    const message = createMessage(fields, key);
    assert.deepEqual(verifyMessage(message, { ...options(), secret: key }), { ok: true });
  }
});

test("each refusal has a named reason and does not throw", () => {
  const message = signed();
  const { sig: _sig, ...missing } = message;
  for (const bad of [missing, { ...message, sig: "00".repeat(32) }, { ...message, sig: "a" }, { ...message, sig: "g".repeat(64) }, { ...message, sig: 1 }, { ...message, sig: `${message.sig}\n` }]) {
    assert.deepEqual(verifyMessage(bad, options()), { ok: false, reason: "bad-signature" });
  }
  for (const [changes, reason] of [
    [{ from: "unknown" }, "unknown-sender"], [{ kind: "exec" }, "unknown-kind"],
    ...["owner", "a/b/c", "/name", "owner/", "owner/name\n", "owner/name\r"].map(repo => [{ repo }, "bad-repo"]),
    ...[null, [], "text", 1].map(body => [{ body }, "bad-body"]),
    [{ time: "invalid" }, "bad-time"], [{ v: 2 }, "bad-version"], [{ id: "" }, "bad-id"],
  ]) {
    const context = options();
    assert.deepEqual(verifyMessage(signed(changes), context), { ok: false, reason });
    assert.deepEqual(context.seen, {});
  }
  for (const value of [null, [], 1, "message"]) assert.deepEqual(verifyMessage(value, options()), { ok: false, reason: "bad-message" });
  assert.deepEqual(verifyMessage(message, { ...options(), secret: "cd".repeat(32) }), { ok: false, reason: "bad-signature" });
  for (const badSecret of [undefined, null, "ab", `${secret}\n`]) assert.deepEqual(verifyMessage(message, { ...options(), secret: badSecret }), { ok: false, reason: "bad-signature" });
  const unusualBody = signed({ body: {} });
  Object.setPrototypeOf(unusualBody.body, { inherited: true });
  assert.deepEqual(verifyMessage(unusualBody, options()), { ok: false, reason: "bad-body" });
  const cyclic = signed({ body: {} });
  cyclic.body.self = cyclic.body;
  assert.deepEqual(verifyMessage(cyclic, options()), { ok: false, reason: "bad-message" });
  assert.deepEqual(verifyMessage(signed({ id: "__proto__" }), options()), { ok: true });
});

test("five minute clock skew is inclusive in both directions", () => {
  for (const offset of [-300_000, 300_000]) assert.deepEqual(verifyMessage(signed({ time: new Date(now + offset).toISOString() }), options()), { ok: true });
  for (const offset of [-300_001, 300_001]) assert.deepEqual(verifyMessage(signed({ time: new Date(now + offset).toISOString() }), options()), { ok: false, reason: "bad-time" });
});
