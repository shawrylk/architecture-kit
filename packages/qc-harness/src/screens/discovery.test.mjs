import test from "node:test";
import assert from "node:assert/strict";
import { safeControl, permitsRequest } from "./write-guard.mjs";
import { pairStates, catalogCoverage, scaffoldEntry, sourceRoutes } from "./discovery.mjs";

test("write guard blocks mutations in English and Japanese and allows local opt-in", () => {
  for (const name of ["Save", "Delete project", "送信", "保存", "確定", "竣工にする", "アップロード", "登録"]) assert.equal(safeControl({ text: name }), false);
  assert.equal(safeControl({ text: "Photos" }), true);
  assert.equal(permitsRequest("POST", "http://localhost/api", { baseUrl: "http://localhost" }), false);
  assert.equal(permitsRequest("POST", "http://localhost/api", { baseUrl: "http://localhost" }, true), true);
  assert.equal(permitsRequest("POST", "https://cloud.test/api", { baseUrl: "https://cloud.test" }, true), false);
  assert.equal(permitsRequest("POST", "https://tenant.auth0.com/u/login", { baseUrl: "https://cloud.test", auth: { domain: "tenant.auth0.com" } }), true);
  assert.equal(permitsRequest("POST", "https://tenant.auth0.com/api/users", { baseUrl: "https://cloud.test", auth: { domain: "tenant.auth0.com" } }), false);
});

test("pairing is one-to-one and coverage requires an entry or a reason", () => {
  const state = title => ({ signature: JSON.stringify({ heading: title, tab: "", menu: "", dialog: "", route: "/" }), width: 390, route: "/", path: [] });
  const old = [state("Projects"), state("Legacy")];
  const next = [state("Projects"), state("Mono")];
  const pairs = pairStates(old, next);
  assert.deepEqual(pairs.map(item => item.kind), ["paired", "legacy-only", "mono-only"]);
  assert.equal(catalogCoverage(old, [{ signatures: [old[0].signature] }], [{ signature: old[1].signature, reason: "Legacy settings" }]).missing.length, 0);
  assert.equal(catalogCoverage(old, [], [{ signature: old[1].signature, reason: "" }]).missing.length, 2);
  assert.match(scaffoldEntry({ ...old[0], path: [{ role: "tab", name: "Photos" }] }, "mono"), /getByRole\("tab"/);
  assert.deepEqual(sourceRoutes('<Route path="/projects/:projectId"/><Route path="/login"/>', { project: "p" }).map(item => item.path), ["/projects/p", "/login"]);
});
