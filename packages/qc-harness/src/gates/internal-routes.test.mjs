import test from "node:test";
import assert from "node:assert/strict";
import { calledInternalRoutes, checkInternalRoutes, declaredInternalRoutes } from "./internal-routes.mjs";

const trigger = `routes: [
  { method: "post", path: "/v1/internal/photos/:photoId/derivatives", auth: "internal", req: [], handler: h },
  { method: "get", path: "/v1/photos", auth: "tenant", req: [], handler: g },
]`;

const worker = {
  path: "workers/media-process/src/entry.ts",
  source: 'const r = await fetch(`${config.apiBaseUrl}/v1/internal/photos/${photoId}/derivatives`, {});',
};

test("an internal route is read out of the trigger", () => {
  assert.deepEqual([...declaredInternalRoutes([trigger])], ["/v1/internal/photos/:/derivatives"]);
});

test("a tenant route is not an internal one", () => {
  assert.equal(declaredInternalRoutes([trigger]).has("/v1/photos"), false);
});

test("a worker's interpolated segment matches the route's parameter", () => {
  assert.deepEqual(checkInternalRoutes(declaredInternalRoutes([trigger]), calledInternalRoutes([worker])), []);
});

test("a worker posting to a path no route serves is named, with the file", () => {
  const stale = {
    path: "workers/media-process/src/entry.ts",
    source: 'fetch(`${base}/v1/internal/photos/${photoId}/thumbnails`, {});',
  };
  const problems = checkInternalRoutes(declaredInternalRoutes([trigger]), calledInternalRoutes([stale]));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "unserved-internal-route");
  assert.match(problems[0].path, /media-process/);
});

test("a segment count mismatch is caught, not smoothed over", () => {
  const deep = { path: "w.ts", source: 'fetch(`${base}/v1/internal/photos/${id}/derivatives/extra`, {});' };
  assert.equal(checkInternalRoutes(declaredInternalRoutes([trigger]), calledInternalRoutes([deep])).length, 1);
});

test("the internal prefix comes from options", () => {
  const declared = declaredInternalRoutes(['path: "/api/private/report"'], { prefix: "/api/private/" });
  const called = calledInternalRoutes(
    [{ path: "workers/a.ts", source: "await post(`${base}/api/private/missing`)" }],
    { prefix: "/api/private/" },
  );
  assert.deepEqual([...declared], ["/api/private/report"]);
  const problems = checkInternalRoutes(declared, called);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "unserved-internal-route");
});
