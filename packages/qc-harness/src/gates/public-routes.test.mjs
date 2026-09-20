import test from "node:test";
import assert from "node:assert/strict";
import { allowedPublicRoutes, checkPublicRoutes, declaredPublicRoutes } from "./public-routes.mjs";

const trigger = `export const trigger = defineTrigger({
  routes: [
    { method: "get", path: "/v1/me", auth: "tenant", req: [], handler: a },
    { method: "post", path: "/v1/shares/:shareId/resolve", auth: "public", req: [], handler: b },
  ],
});`;

const bff = `export const PUBLIC_ROUTES = [
  { method: "POST", path: "/v1/shares/:shareId/resolve" },
];`;

test("a public route is read out of the trigger that declares it", () => {
  assert.deepEqual([...declaredPublicRoutes([trigger])], ["POST /v1/shares/:shareId/resolve"]);
});

test("a tenant route is never read as public", () => {
  assert.equal(declaredPublicRoutes([trigger]).has("GET /v1/me"), false);
});

test("two lists that agree pass", () => {
  assert.deepEqual(checkPublicRoutes(declaredPublicRoutes([trigger]), allowedPublicRoutes(bff), "bff"), []);
});

test("a public api route the bff still guards is unreachable, and is named", () => {
  const problems = checkPublicRoutes(declaredPublicRoutes([trigger]), new Set(), "bff");
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "public-route-unreachable");
});

test("a route the bff opens that no api route declares public is a hole, and is named", () => {
  const problems = checkPublicRoutes(new Set(), allowedPublicRoutes(bff), "bff");
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "public-route-unguarded");
});
