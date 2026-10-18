import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { browserSession, seedSession } from "./auth.mjs";

for (const method of ["profile", "state", "headed", "seed"]) {
  test(`${method} context blocks service workers`, async t => {
    const root = mkdtempSync(path.join(os.tmpdir(), "qc-context-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    t.mock.method(os, "homedir", () => root);
    const directory = path.join(root, ".qc", "screens");
    mkdirSync(path.join(directory, "state"), { recursive: true });
    const emptyState = { cookies: [], origins: [] };
    if (method === "state") writeFileSync(path.join(directory, "state", "tenant.test.json"), JSON.stringify(emptyState));
    if (method === "seed") writeFileSync(path.join(directory, "local-4567.json"), JSON.stringify(emptyState));
    const source = path.join(root, "chrome");
    if (method === "profile") {
      mkdirSync(source);
      writeFileSync(path.join(source, "Local State"), JSON.stringify({ profile: { last_used: "Default" } }));
    }
    const target = { baseUrl: "http://localhost:4567", auth: { domain: "tenant.test", signedIn: "main" } };
    const context = {
      close: async () => {}, route: async () => {}, storageState: async () => emptyState,
      newPage: async () => ({ goto: async () => {}, url: () => target.baseUrl, locator: () => ({ first: () => ({ waitFor: async () => {} }) }) }),
    };
    const factories = [];
    const chromium = {
      launchPersistentContext: async (_directory, options) => { factories.push(["persistent", options]); return context; },
      launch: async () => ({ close: async () => {}, newContext: async options => { factories.push(["new", options]); return context; } }),
    };
    const session = await (method === "seed"
      ? seedSession(chromium, target, { savedOnly: true })
      : browserSession(chromium, target, { chromeProfile: source, allowInteractive: method !== "state", say: () => {} }));
    await session.close();
    assert.equal(factories.length, 1);
    assert.equal(factories[0][0], method === "profile" ? "persistent" : "new");
    assert.equal(factories[0][1].serviceWorkers, "block");
  });
}
