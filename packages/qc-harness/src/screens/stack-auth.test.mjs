import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { accountFields, applyStackLogin, refreshDue, recordRefresh, refreshStackSessions } from "./stack-auth.mjs";
import { chromium } from "playwright";
import { parseMap } from "./map.mjs";

test("a failed stack refresh waits the normal interval before retrying", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-refresh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.mock.method(os, "homedir", () => root);
  const target = { stack: "fixture", baseUrl: "http://localhost:4567", auth: { mode: "browser-session", domain: "tenant.test", signedIn: "main" } };
  await recordRefresh(target);
  const directory = path.join(root, ".qc", "screens", "state");
  mkdirSync(directory);
  writeFileSync(path.join(directory, "tenant.test.json"), JSON.stringify({ cookies: [], origins: [] }));
  let now = Date.now() + 24 * 60 * 60 * 1000;
  t.mock.method(Date, "now", () => now);
  let launches = 0;
  t.mock.method(chromium, "launch", async () => {
    launches++;
    throw new Error("Browser unavailable");
  });
  for (let tick = 0; tick < 5; tick++) {
    await refreshStackSessions("fixture").catch(() => {});
    now += 1000;
  }
  assert.equal(launches, 1);
  now += 23 * 60 * 60 * 1000;
  await assert.rejects(refreshStackSessions("fixture"));
  assert.equal(launches, 2);
});

test("stack form login reads the legacy email, secret, and submit selectors", () => {
  const target = { baseUrl: "http://localhost:3300", auth: { signedIn: "main" } };
  applyStackLogin(target, { login: { kind: "form", url: "/login", selectors: { email: "#username", secret: "#password", submit: "[data-testid=button-login-submit]" } } });
  const map = parseMap({ widths: [390], targets: { legacy: target, other: structuredClone(target) }, screens: [{ name: "projects", targets: { legacy: { path: "/projects" }, other: { path: "/projects" } } }] });
  assert.equal(map.targets.legacy.auth.userSelector, "#username");
  assert.equal(map.targets.legacy.auth.passwordSelector, "#password");
  assert.equal(map.targets.legacy.auth.submitSelector, "[data-testid=button-login-submit]");
});

test("accounts read named environment fields without evaluation", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-account-"));
  const file = path.join(root, "accounts.env");
  try {
    const value = `${randomUUID()}$(never-run)`;
    writeFileSync(file, `# account\nQC_TEST_EMAIL="a@example.test"\nQC_TEST_PASSWORD=${value}\n`);
    assert.deepEqual(accountFields(file), { user: "a@example.test", password: value });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stack auth keeps mono on its real Auth0 flow and limits form login to localhost", () => {
  const target = { baseUrl: "http://localhost:5173", auth: { domain: "tenant.auth0.com", signedIn: "main" } };
  applyStackLogin(target, { login: { kind: "auth0-session" } });
  assert.equal(target.auth.mode, "browser-session");
  assert.equal(target.auth.path, "/bff/login?returnTo=%2Fprojects");
  assert.throws(() => applyStackLogin({ baseUrl: "https://cloud.test", auth: {} }, { login: { kind: "form", url: "/login" } }), /localhost/);
  assert.throws(() => applyStackLogin(target, { login: { kind: "local-token" } }), /Unsupported/);
  assert.equal(refreshDue({ lastRefreshed: new Date(Date.now() - 86400000).toISOString() }), true);
  assert.equal(refreshDue({ lastRefreshed: new Date().toISOString() }), false);
});
