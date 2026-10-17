import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { requireLocalhost } from "./map.mjs";
import { loadStack, healthUrls } from "../stack/stack.mjs";
import { browserSession, seedSession, privateRoot } from "./auth.mjs";

/** Resource: read credentials as literals without evaluating shell expressions. */
export function accountFields(file = path.join(os.homedir(), ".qc", "accounts.env")) {
  const source = readFileSync(file, "utf8");
  const get = key => {
    const value = source.match(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`, "m"))?.[1]?.trim();
    if (!value) throw new Error("accounts.env requires QC_TEST_EMAIL and QC_TEST_PASSWORD");
    return /^["']/.test(value) && value.at(-1) === value[0] ? value.slice(1, -1) : value;
  };
  return { user: get("QC_TEST_EMAIL"), password: get("QC_TEST_PASSWORD") };
}

/** Branch: each plugin selects one real sign-in flow. */
export function applyStackLogin(target, manifest) {
  const login = manifest.login;
  if (login.kind === "auth0-session") {
    target.auth = { ...target.auth, mode: "browser-session", path: login.url ?? "/bff/login?returnTo=%2Fprojects" };
  } else if (login.kind === "form") {
    requireLocalhost(target.baseUrl);
    const url = new URL(login.url, target.baseUrl);
    requireLocalhost(url.href);
    if (url.origin !== new URL(target.baseUrl).origin) throw new Error("Form login must use the target origin");
    target.auth = { ...target.auth, mode: "form", path: url.pathname + url.search, userSelector: login.selectors?.email, passwordSelector: login.selectors?.password, submitSelector: login.selectors?.submit };
  } else throw new Error(`Unsupported login kind: ${login.kind}`);
  return target;
}

/** Pipeline: resolve current stack URLs before validating the screen map. */
export function resolveStackTargets(input, names) {
  for (const [name, target] of Object.entries(input.targets)) if (target.stack && (!names || names.includes(name))) {
    const { manifest } = loadStack(target.stack);
    target.baseUrl = new URL(healthUrls(manifest)[0]).origin;
    applyStackLogin(target, manifest);
  }
  return input;
}

const metadataFile = target => path.join(privateRoot(), `session-${createHash("sha256").update(target.baseUrl).digest("hex").slice(0, 16)}.json`);

/** Ledger: refresh times belong to each application rather than its shared tenant. */
export function recordRefresh(target) {
  writeFileSync(metadataFile(target), JSON.stringify({ target, lastRefreshed: new Date().toISOString() }), { mode: 0o600 });
}

export function refreshDue(record, now = Date.now()) {
  return !record?.lastRefreshed || now - Date.parse(record.lastRefreshed) >= 23 * 60 * 60 * 1000;
}

/** Pipeline: authenticate each target through its declared mechanism. */
export async function targetSession(chromium, target, options = {}) {
  const session = await (target.auth.mode === "browser-session" ? browserSession(chromium, target, options) : seedSession(chromium, target, { ...options, credentials: target.auth.mode === "form" ? accountFields() : undefined }));
  recordRefresh(target);
  return session;
}

/** Pipeline: validate saved state without opening an interactive window. */
export async function authStatus(chromium, targets, options = {}) {
  const rows = [];
  for (const [name, target] of Object.entries(targets)) {
    const file = metadataFile(target);
    let lastRefreshed = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).lastRefreshed : null;
    let valid = false;
    try {
      const session = await (target.auth.mode === "browser-session" ? browserSession(chromium, target, { ...options, allowInteractive: false }) : seedSession(chromium, target, { ...options, savedOnly: true }));
      await session.close();
      recordRefresh(target);
      lastRefreshed = JSON.parse(readFileSync(file, "utf8")).lastRefreshed;
      valid = true;
    } catch {}
    rows.push({ target: name, valid, lastRefreshed });
  }
  return rows;
}

/** Trigger: a running stack slides its real Auth0 session before a day elapses. */
export async function refreshStackSessions(stack) {
  const { readdirSync } = await import("node:fs");
  for (const name of readdirSync(privateRoot()).filter(name => /^session-.*\.json$/.test(name))) {
    const record = JSON.parse(readFileSync(path.join(privateRoot(), name), "utf8"));
    if (record.target.stack !== stack || !refreshDue(record)) continue;
    const { chromium } = await import("playwright");
    const target = { ...record.target, auth: { ...record.target.auth, path: "/bff/login?returnTo=%2Fprojects" } };
    const session = await targetSession(chromium, target, { timeout: 15000, signInTimeout: 180000 });
    await session.close();
  }
}
