import test from "node:test";
import assert from "node:assert/strict";
import { parseMap, requireLocalhost } from "./map.mjs";

const fixture = () => ({ widths: [2514, 390], targets: { old: { baseUrl: "https://old.example", auth: { mode: "browser-session", domain: "tenant.auth0.com", signedIn: "[data-user]" } }, next: { baseUrl: "http://localhost:5173", auth: { mode: "browser-session", domain: "tenant.auth0.com", signedIn: "[data-user]" } } }, screens: [{ name: "projects", targets: { old: { path: "/projects" }, next: { path: "/projects" } } }] });

test("map preserves widths and resolves target paths", () => {
  const map = parseMap(fixture());
  assert.deepEqual(map.widths, [2514, 390]);
  assert.equal(map.screens[0].targets.old.path, "/projects");
});

test("map rejects traversal, duplicate names, unknown targets, and invalid widths", () => {
  for (const mutate of [m => m.screens[0].name = "../escape", m => m.screens.push(m.screens[0]), m => m.widths = [0], m => m.screens[0].targets.unknown = { path: "/" }, m => m.screens[0].targets.old.path = "https://evil.example", m => m.targets.old.auth.domain = "../tenant"]) {
    const map = fixture();
    mutate(map);
    assert.throws(() => parseMap(map));
  }
});

test("seed login accepts only exact loopback hosts", () => {
  for (const url of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) assert.doesNotThrow(() => requireLocalhost(url));
  for (const url of ["https://cloud.example", "http://localhost.evil", "http://127.0.0.2", "file:///tmp", "http://localhost@evil.example"]) assert.throws(() => requireLocalhost(url));
  const map = fixture();
  map.targets.old.auth = { mode: "seed-login", signedIn: "main", seedFile: "seed.json", userField: "username", passwordField: "password", userSelector: "#user", passwordSelector: "#password", submitSelector: "#login" };
  assert.throws(() => parseMap(map), /localhost/);
});

test("map accepts optional navigation for onboarding and rejects malformed steps", () => {
  const map = fixture();
  map.screens[0].targets.old.clicks = [{ selector: "[data-guide-skip]", optional: true }];
  assert.doesNotThrow(() => parseMap(map));
  map.screens[0].targets.old.clicks = [{ optional: true }];
  assert.throws(() => parseMap(map));
});
