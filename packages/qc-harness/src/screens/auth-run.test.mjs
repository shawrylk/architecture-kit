import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { browserSession, seedSession } from "./auth.mjs";
import { runScreens } from "../cli/screens.mjs";
import { captureScreens } from "./capture.mjs";
import { chromeMissing } from "./chrome.mjs";

const noChrome = await chromeMissing(chromium);

async function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-auth-run-"));
  t.mock.method(os, "homedir", () => root);
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader("content-type", "text/html");
    if (req.url.startsWith("/bff/login") && req.headers.cookie?.includes("sso=yes")) {
      res.writeHead(302, { "set-cookie": "app=yes; Path=/; HttpOnly", location: "/projects" }).end();
    } else if (req.url === "/projects" && req.headers.cookie?.includes("app=yes")) res.end('<main id="signed">Projects</main>');
    else res.end('<input id="user"><input id="pass" type="password"><button id="submit">Login</button>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const target = { baseUrl, auth: { mode: "browser-session", domain: "fixture.auth0.test", path: "/projects", signedIn: "#signed" } };
  const state = path.join(root, ".qc/screens/state/fixture.auth0.test.json");
  mkdirSync(path.dirname(state), { recursive: true });
  const save = cookies => writeFileSync(state, JSON.stringify({ cookies: cookies.map(name => ({ name, value: "yes", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" })), origins: [] }));
  return { root, requests, target, state, save };
}

test("expired application state refreshes once through the login path and persists the renewed cookie", { skip: noChrome }, async t => {
  const f = await fixture(t);
  f.save(["sso"]);
  const session = await browserSession(chromium, f.target, { targetName: "new-local", timeout: 3000, allowInteractive: false });
  await session.close();
  assert.equal(f.requests.filter(p => p.startsWith("/bff/login")).length, 1);
  assert.ok(JSON.parse(readFileSync(f.state)).cookies.some(c => c.name === "app"));
});

test("seed errors name the target and failing field without exposing browser diagnostics or credentials", { skip: noChrome }, async t => {
  const f = await fixture(t);
  const target = { ...f.target, auth: { ...f.target.auth, mode: "seed-login", path: "/login", userSelector: "#user", passwordSelector: "#missing", submitSelector: "#submit" } };
  await assert.rejects(seedSession(chromium, target, { targetName: "old-local", credentials: { user: "test", password: randomUUID() }, timeout: 3000 }), error => {
    assert.equal(error.message, "old-local: seed sign-in failed at the password field");
    return true;
  });
});

test("run stops with code four and one human instruction without capturing or retrying", { skip: noChrome }, async t => {
  const f = await fixture(t);
  f.save([]);
  const map = path.join(f.root, "map.json");
  writeFileSync(map, JSON.stringify({ widths: [200], targets: { "new-local": f.target, other: f.target }, screens: [{ name: "projects", targets: { "new-local": { path: "/projects" }, other: { path: "/projects" } } }] }));
  const lines = [];
  const code = await runScreens(["run", "projects", "--map", map, "--targets", "new-local,other", "--out", path.join(f.root, "out"), "--timeout", "3000", "--sign-in-timeout", "100"], { say: line => lines.push(line) });
  assert.equal(code, 4);
  assert.deepEqual(lines, ["new-local: needs a person to sign in (run qc screens auth new-local --headed)"]);
  assert.equal(f.requests.filter(p => p.startsWith("/bff/login")).length, 1);
});

test("capture checks each target once before navigating any screen and closes earlier sessions on failure", async t => {
  const f = await fixture(t);
  const events = [];
  await assert.rejects(captureScreens({ widths: [200], targets: { first: f.target, second: f.target }, screens: [{ name: "projects", targets: { first: { path: "/projects" }, second: { path: "/projects" } } }] }, { targets: ["first", "second"], out: path.join(f.root, "out") }, {
    sessionFactory: async (_chromium, _target, options) => {
      events.push(options.targetName);
      assert.equal(options.allowInteractive, false);
      if (options.targetName === "second") throw new Error("second failed");
      return { context: { route: async () => {} }, page: { setViewportSize: async () => { throw new Error("capture before preflight"); } }, close: async () => events.push("closed") };
    },
  }), /second failed/);
  assert.deepEqual(events, ["first", "second", "closed"]);
});


// A headed browser needs a display, which a Linux CI runner lacks.
test("headed auth accepts the named target and saves a valid session", { skip: noChrome || (process.platform === "linux" && !process.env.DISPLAY) }, async t => {
  const f = await fixture(t);
  f.save(["app"]);
  const map = path.join(f.root, "map.json");
  writeFileSync(map, JSON.stringify({ widths: [200], targets: { "new-local": f.target, other: f.target }, screens: [{ name: "projects", targets: { "new-local": { path: "/projects" }, other: { path: "/projects" } } }] }));
  const lines = [];
  assert.equal(await runScreens(["auth", "new-local", "--headed", "--map", map, "--timeout", "3000"], { say: line => lines.push(line) }), 0);
  assert.deepEqual(lines, ["new-local: signed in"]);
  assert.ok(JSON.parse(readFileSync(f.state)).cookies.some(c => c.name === "app"));
});

test("parallel sessions preserve the shared saved state and write a complete refresh ledger", { skip: noChrome }, async t => {
  const f = await fixture(t);
  f.save(["sso"]);
  const { targetSession } = await import("./stack-auth.mjs");
  const sessions = await Promise.all(Array.from({ length: 3 }, () => targetSession(chromium, f.target, { targetName: "new-local", timeout: 3000, allowInteractive: false })));
  await Promise.all(sessions.map(s => s.close()));
  assert.equal(f.requests.filter(p => p.startsWith("/bff/login")).length, 1);
  assert.ok(JSON.parse(readFileSync(f.state)).cookies.some(c => c.name === "app"));
  const files = readdirSync(path.join(f.root, ".qc/screens"));
  const ledger = files.filter(name => /^session-.*\.json$/.test(name));
  assert.equal(ledger.length, 1);
  const record = JSON.parse(readFileSync(path.join(f.root, ".qc/screens", ledger[0])));
  assert.equal(record.target.baseUrl, f.target.baseUrl);
  assert.ok(Number.isFinite(Date.parse(record.lastRefreshed)));
  assert.equal(files.some(name => name.endsWith(".lock") || name.endsWith(".tmp")), false);
  assert.deepEqual(readdirSync(path.dirname(f.state)), ["fixture.auth0.test.json"]);
});

test("a browser launch failure names the target and method without asking for human sign-in", async t => {
  const f = await fixture(t);
  f.save([]);
  await assert.rejects(browserSession({ launch: async () => { throw new Error("private browser diagnostics"); } }, f.target, { targetName: "new-local", allowInteractive: false }), error => {
    assert.equal(error.message, "new-local: browser-session sign-in failed at the browser");
    assert.equal(error.exitCode, undefined);
    return true;
  });
});

test("--allow-writes reaches the capture write guard as well as the session", async t => {
  const f = await fixture(t);
  const verdicts = [];
  const report = await captureScreens({ widths: [200], targets: { first: f.target, second: f.target }, screens: [{ name: "projects", targets: { first: { path: "/projects" }, second: { path: "/projects" } } }] }, { targets: ["first", "second"], out: path.join(f.root, "out"), allowWrites: true }, {
    say: () => {},
    sessionFactory: async (_chromium, _target, options) => {
      assert.equal(options.allowWrites, true);
      const context = { route: async (_pattern, handler) => {
        await handler({ request: () => ({ method: () => "POST", url: () => `${f.target.baseUrl}/api/items` }), fallback: async () => verdicts.push("allowed"), abort: async () => verdicts.push("blocked") });
      } };
      return { context, page: { setViewportSize: async () => { throw new Error("stop after the guard"); } }, close: async () => {} };
    },
  });
  assert.equal(report[0].error.message, "stop after the guard");
  assert.deepEqual(verdicts, ["allowed", "allowed"]);
});

test("a cached target also passes preflight before a changed-target capture", async t => {
  const f = await fixture(t);
  const names = [];
  await assert.rejects(captureScreens({ widths: [200], targets: { first: f.target, second: f.target }, screens: [{ name: "projects", targets: { first: { path: "/projects" }, second: { path: "/projects" } } }] }, { targets: ["first", "second"], changed: "second", out: path.join(f.root, "out") }, {
    sessionFactory: async (_chromium, _target, options) => { names.push(options.targetName); throw new Error("preflight failed"); },
  }), /preflight failed/);
  assert.deepEqual(names, ["first"]);
});
