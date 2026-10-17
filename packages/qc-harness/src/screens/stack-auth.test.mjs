import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { accountFields, applyStackLogin, refreshDue } from "./stack-auth.mjs";

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
