import test from "node:test";
import assert from "node:assert/strict";
import { checkContractRoutes, declaredTriggerRoutes } from "./contract-routes.mjs";

const trigger = {
  path: "server/features/photos/trigger.ts",
  source: `routes: [
  { method: "post", path: "/v1/photos/:photoId/derivatives", auth: "tenant", req: [], handler: h },
  { method: "get", path: "/v1/photos", auth: "tenant", req: [], handler: g },
]`,
};

const operations = [
  { method: "post", path: "/v1/photos/{photoId}/derivatives" },
  { method: "get", path: "/v1/photos" },
];

const check = (routes, ops, options = {}) => checkContractRoutes(routes, ops, { contract: "contracts/openapi.yaml", exempt: [], ...options });

test("a route is read with its method, its path and its file", () => {
  assert.deepEqual(declaredTriggerRoutes([trigger]), [
    { method: "post", path: "/v1/photos/:photoId/derivatives", file: trigger.path },
    { method: "get", path: "/v1/photos", file: trigger.path },
  ]);
});

test("a route and an operation that agree pass, and :id against {id} is one segment", () => {
  assert.deepEqual(check(declaredTriggerRoutes([trigger]), operations), []);
  const renamed = [{ method: "get", path: "/v1/photos/{id}" }];
  const routes = declaredTriggerRoutes([{ path: "t.ts", source: 'x({ method: "GET", path: "/v1/photos/:photoId" })' }]);
  assert.deepEqual(check(routes, renamed), []);
});

test("a route that differs from the contract by one segment fails both ways", () => {
  const routes = declaredTriggerRoutes([trigger]);
  const drifted = [operations[0], { method: "get", path: "/v1/pictures" }];
  const problems = check(routes, drifted);
  assert.deepEqual(problems.map(({ rule }) => rule).sort(), ["operation-not-served", "route-not-in-contract"]);
  const unserved = problems.find(({ rule }) => rule === "route-not-in-contract");
  assert.equal(unserved.path, trigger.path);
  assert.match(unserved.detail, /get \/v1\/photos/);
  const missing = problems.find(({ rule }) => rule === "operation-not-served");
  assert.equal(missing.path, "contracts/openapi.yaml");
  assert.match(missing.detail, /get \/v1\/pictures/);
});

test("the method is compared as well as the path", () => {
  const routes = declaredTriggerRoutes([trigger]);
  const swapped = [{ method: "put", path: "/v1/photos/{photoId}/derivatives" }, operations[1]];
  assert.deepEqual(check(routes, swapped).map(({ rule }) => rule).sort(), ["operation-not-served", "route-not-in-contract"]);
});

test("an exempt internal route passes", () => {
  const routes = declaredTriggerRoutes([
    trigger,
    { path: "server/features/media/trigger.ts", source: '{ method: "post", path: "/v1/internal/media/:id/done", auth: "internal" }' },
  ]);
  const exempt = [{ method: "POST", path: "/v1/internal/media/{mediaId}/done", why: "a worker callback, not a public operation" }];
  assert.deepEqual(check(routes, operations, { exempt }), []);
  assert.equal(check(routes, operations).length, 1);
});

test("an exempt operation the api does not serve passes", () => {
  const exempt = [{ method: "get", path: "/v1/health", why: "served by the edge" }];
  const ops = [...operations, { method: "get", path: "/v1/health" }];
  assert.deepEqual(check(declaredTriggerRoutes([trigger]), ops, { exempt }), []);
});

test("a stale exemption fails", () => {
  const routes = declaredTriggerRoutes([trigger]);
  const gone = [{ method: "post", path: "/v1/internal/gone", why: "removed long ago" }];
  const problems = check(routes, operations, { exempt: gone });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "stale-route-exemption");
  assert.match(problems[0].detail, /post \/v1\/internal\/gone/);
});

test("an exemption for a route the contract now lists is stale too", () => {
  const exempt = [{ method: "get", path: "/v1/photos", why: "not yet in the contract" }];
  const problems = check(declaredTriggerRoutes([trigger]), operations, { exempt });
  assert.deepEqual(problems.map(({ rule }) => rule), ["stale-route-exemption"]);
});

test("a trigger with no routes and a contract with no operations agree", () => {
  assert.deepEqual(check(declaredTriggerRoutes([{ path: "t.ts", source: "export {};" }]), []), []);
});
