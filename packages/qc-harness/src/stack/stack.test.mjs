import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { stackAction, validateManifest } from "./stack.mjs";

test("stack up waits for health, status observes it, and down stops its process", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-stack-"));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const manifest = { name: "fixture", up: "node server.cjs", down: "node -e \"process.exit(0)\"", status: "node -e \"process.exit(0)\"", ports: { web: port }, health: [`http://127.0.0.1:${port}`], login: { kind: "form", url: "/login" } };
  writeFileSync(path.join(root, "qc.stack.json"), JSON.stringify(manifest));
  writeFileSync(path.join(root, "server.cjs"), `require('node:http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1')`);
  try {
    const options = { registry: { fixture: root }, stateRoot: path.join(root, "state"), timeout: 8000 };
    assert.equal((await stackAction("up", ["fixture"], options))[0].healthy, true);
    assert.equal((await stackAction("status", ["fixture"], options))[0].healthy, true);
    const other = path.join(root, "other");
    mkdirSync(other);
    writeFileSync(path.join(other, "qc.stack.json"), JSON.stringify({ ...manifest, name: "other" }));
    await assert.rejects(stackAction("up", ["fixture", "other"], { ...options, registry: { fixture: root, other } }), /Stack other: port .* is in use/);
    assert.equal((await stackAction("down", ["fixture"], options))[0].running, false);
    await new Promise(resolve => probe.listen(port, "127.0.0.1", resolve));
    await assert.rejects(stackAction("up", ["fixture"], options), /in use/);
    await new Promise(resolve => probe.close(resolve));
  } finally { if (probe.listening) await new Promise(resolve => probe.close(resolve)); rmSync(root, { recursive: true, force: true }); }
});
test("stack accepts a database on port 5432", () => {
  const manifest = { name: "x", up: "node app", down: "node stop", ports: { db: 5432 }, health: ["http://localhost:3000"], login: { kind: "auth0-session" } };
  assert.equal(validateManifest(manifest).ports.db, 5432);
});
test("stack refuses remote health URLs", () => {
  const manifest = { name: "x", up: "node app", down: "node stop", ports: { db: 5433 }, health: ["http://localhost:3000"], login: { kind: "auth0-session" } };
  manifest.health = ["https://cloud.example"];
  assert.throws(() => validateManifest(manifest), /localhost/);
});
