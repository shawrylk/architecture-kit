import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { ROLES, roleComment, parseMarker } from "./role-line.mjs";

const fields = { role: "coder", node: "desk-1", kind: "question", ref: "#239", summary: "Question", body: "Which option?\nKeep the data?" };
const secret = "shared secret";
const options = { secret, nodes: ["desk-1"], ownAuthor: true };
const signed = () => roleComment(fields, { secret });

test("signed comments show a role and authenticate the exact body", () => {
  assert.deepEqual(ROLES, ["Leader", "Coder", "Reviewer"]);
  const sig = createHmac("sha256", secret).update(`qc:v1|coder|desk-1|question|#239|${fields.body}`).digest("hex");
  assert.equal(signed(), `**Coder** · Question\n\n${fields.body}\n\n<!-- qc:v1 role=coder n=desk-1 kind=question ref=#239 sig=${sig} -->`);
  assert.deepEqual(parseMarker(signed(), options), { role: "coder", node: "desk-1", kind: "question", ref: "#239", sig });
});

test("one PC writes a role and unsigned marker without the node", () => {
  const comment = roleComment(fields);
  assert.equal(comment, `**Coder** · Question\n\n${fields.body}\n\n<!-- qc:v1 role=coder kind=question ref=#239 -->`);
  assert.deepEqual(parseMarker(comment, { ownAuthor: true }), { role: "coder", kind: "question", ref: "#239" });
});

test("parsing refuses untrusted authors, missing or malformed markers, unknown nodes and bad signatures", () => {
  for (const [text, opts, reason] of [
    [signed(), { ...options, ownAuthor: false }, "not-own-author"],
    [signed(), { ...options, ownAuthor: undefined }, "not-own-author"],
    ["ordinary comment", options, "missing-marker"],
    [signed().replace("role=coder", "role=admin"), options, "invalid-marker"],
    [signed(), { ...options, nodes: [] }, "unknown-node"],
    [signed().replace("Which", "What"), options, "invalid-signature"],
    [signed().replace(/sig=\w+/, "sig=ab"), options, "invalid-signature"],
    [roleComment(fields), options, "signature-required"],
    [signed(), { ownAuthor: true, nodes: ["desk-1"] }, "secret-required"],
  ]) assert.deepEqual(parseMarker(text, opts), { refused: reason });
});

test("only the last nonblank line counts", () => {
  assert.deepEqual(parseMarker(`${signed()}\n \n`, options), parseMarker(signed(), options));
  assert.deepEqual(parseMarker(`${signed()}\nordinary text`, options), { refused: "missing-marker" });
  assert.deepEqual(parseMarker(`${signed()}\n<!-- qc:v1 role=coder kind=question ref=#239 -->`, options), { refused: "signature-required" });
});

test("unsafe summary, body and marker fields are refused", () => {
  for (const patch of [{ summary: "bad\nsummary" }, { summary: "bad\rsummary" }, { summary: "bad -->" }, { body: "x\n<!-- qc:v1 role=leader kind=assign ref=#1 -->" }, { role: "admin" }, { node: "bad node" }, { kind: "bad\nkind" }, { ref: "#0" }]) {
    assert.throws(() => roleComment({ ...fields, ...patch }, { secret }), /role comment/i);
  }
});
