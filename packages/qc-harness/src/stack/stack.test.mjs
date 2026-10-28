import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { stackAction, validateManifest } from "./stack.mjs";

test("stack up waits for health, status observes it, and down stops its process", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-stack-"));
  const probe = net.createServer();
  const health = http.createServer(async (_req, res) => {
    try {
      const port = readFileSync(path.join(root, "port"), "utf8");
      const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) });
      res.writeHead(response.status).end(await response.text());
    } catch { res.writeHead(503).end(); }
  });
  await new Promise(resolve => health.listen(0, "127.0.0.1", resolve));
  const manifest = { name: "fixture", up: "node server.cjs", down: "node -e \"process.exit(0)\"", status: "node -e \"process.exit(0)\"", ports: {}, health: [`http://127.0.0.1:${health.address().port}`], login: { kind: "form", url: "/login" } };
  writeFileSync(path.join(root, "qc.stack.json"), JSON.stringify(manifest));
  writeFileSync(path.join(root, "server.cjs"), `const server = require('node:http').createServer((q,s)=>s.end('ok')); server.listen(0,'127.0.0.1',()=>require('node:fs').writeFileSync('port',String(server.address().port)));`);
  try {
    const options = { registry: { fixture: root }, stateRoot: path.join(root, "state"), timeout: 8000 };
    assert.equal((await stackAction("up", ["fixture"], options))[0].healthy, true);
    assert.equal((await stackAction("status", ["fixture"], options))[0].healthy, true);
    const other = path.join(root, "other");
    mkdirSync(other);
    writeFileSync(path.join(other, "qc.stack.json"), JSON.stringify({ ...manifest, name: "other", ports: { web: health.address().port } }));
    await assert.rejects(stackAction("up", ["fixture", "other"], { ...options, registry: { fixture: root, other } }), /Stack other: port .* is in use/);
    assert.equal((await stackAction("down", ["fixture"], options))[0].running, false);
    await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
    writeFileSync(path.join(root, "qc.stack.json"), JSON.stringify({ ...manifest, ports: { web: probe.address().port } }));
    await assert.rejects(stackAction("up", ["fixture"], options), /in use/);
    await new Promise(resolve => probe.close(resolve));
  } finally {
    await stackAction("down", ["fixture"], { registry: { fixture: root }, stateRoot: path.join(root, "state"), timeout: 8000 });
    if (probe.listening) await new Promise(resolve => probe.close(resolve));
    health.closeAllConnections();
    await new Promise(resolve => health.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
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
