import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { firstSignedIn, seedFields, copyChromeProfile } from "./auth.mjs";

test("auth falls back in order and stops at the first signed-in context", async () => {
  const calls = [];
  const session = { signedIn: true };
  const result = await firstSignedIn([
    async () => { calls.push("state"); return null; },
    async () => { calls.push("profile"); return session; },
    async () => { calls.push("headed"); throw new Error("must not run"); },
  ]);
  assert.equal(result, session);
  assert.deepEqual(calls, ["state", "profile"]);
});

test("auth reaches headed fallback after both reusable sessions fail", async () => {
  const calls = [];
  const session = {};
  assert.equal(await firstSignedIn([async () => { calls.push(1); return null; }, async () => { calls.push(2); return null; }, async () => { calls.push(3); return session; }]), session);
  assert.deepEqual(calls, [1, 2, 3]);
  await assert.rejects(firstSignedIn([async () => null]), /signed-in/);
});

test("profile copy includes cookies and excludes Chrome's password store", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-screen-profile-"));
  try {
    const source = path.join(root, "source");
    mkdirSync(path.join(source, "Default", "Network"), { recursive: true });
    writeFileSync(path.join(source, "Local State"), JSON.stringify({ profile: { last_used: "Default" } }));
    writeFileSync(path.join(source, "Default", "Network", "Cookies"), "encrypted cookie fixture");
    writeFileSync(path.join(source, "Default", "Login Data"), "password store fixture");
    const copy = copyChromeProfile(root, source);
    assert.equal(existsSync(path.join(copy.directory, "Default", "Network", "Cookies")), true);
    assert.equal(existsSync(path.join(copy.directory, "Default", "Login Data")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("seed fields support JSON paths and literal source fields without evaluating code", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-screen-seed-"));
  try {
    const seedFile = path.join(root, "seed.json");
    writeFileSync(seedFile, JSON.stringify({ account: { name: "a", pass: "b" } }));
    assert.deepEqual(seedFields({ seedFile, userField: "account.name", passwordField: "account.pass" }), { user: "a", password: "b" });
    writeFileSync(seedFile, 'const account = { username: "a", password: "b" }; throw new Error("must not evaluate");');
    assert.deepEqual(seedFields({ seedFile, userField: "username", passwordField: "password" }), { user: "a", password: "b" });
    writeFileSync(seedFile, 'const password = getSecret();');
    assert.throws(() => seedFields({ seedFile, userField: "username", passwordField: "password" }), /^Error: Cannot read the named seed fields$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
