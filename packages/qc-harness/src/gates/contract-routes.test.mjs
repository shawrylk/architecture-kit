import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaults, load } from "../config.mjs";
import { runCheck } from "../cli/check.mjs";
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

// The runner reads each feature trigger and the contract from disk.
const GATE_RULES = new Set(["route-not-in-contract", "operation-not-served", "stale-route-exemption", "exemption-without-reason", "malformed-exemption", "unreadable-contract", "contract-reader-unavailable"]);

async function checked({ contract, triggerSource = trigger.source, gates = { "contract-routes": true }, overrides = {} }) {
  const dir = mkdtempSync(path.join(tmpdir(), "qc-routes-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const base = load(dir);
    mkdirSync(path.join(dir, base.paths.serverFeatures, "photos"), { recursive: true });
    writeFileSync(path.join(dir, base.paths.serverFeatures, "photos", base.paths.triggerFile), triggerSource);
    const file = overrides.contract ?? "contracts/openapi.yaml";
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    if (contract !== undefined) writeFileSync(path.join(dir, file), contract);
    const config = { ...base, ...overrides, gates: { ...base.gates, ...gates } };
    const { problems, lines } = await runCheck(config);
    return { problems: problems.filter((problem) => GATE_RULES.has(problem.rule)), lines };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CONTRACT = ["paths:", "  /v1/photos/{photoId}/derivatives:", "    post: {}", "  /v1/photos:", "    get: {}", ""].join(String.fromCharCode(10));

test("qc check compares the triggers with the contract", async () => {
  const agreed = await checked({ contract: CONTRACT });
  assert.deepEqual(agreed.problems, []);
  assert.ok(agreed.lines.some((line) => line.includes("contract")));
  const drifted = await checked({ contract: CONTRACT.replace("/v1/photos:", "/v1/pictures:") });
  assert.deepEqual(drifted.problems.map((problem) => problem.rule).sort(), ["operation-not-served", "route-not-in-contract"]);
  assert.ok(drifted.problems.some((problem) => problem.path.endsWith("trigger.ts")));
});

test("the gate ships off, and an absent contract is ordinary", async () => {
  assert.equal(defaults.gates["contract-routes"], false);
  assert.deepEqual((await checked({ contract: "paths: {}", gates: {} })).problems, []);
  assert.deepEqual((await checked({})).problems, []);
});

test("config.contractRoutes.exempt excuses a route, and a stale one fails", async () => {
  const extra = { ...trigger, source: `${trigger.source}\n  { method: "post", path: "/v1/internal/x" },` };
  const exempt = [{ method: "post", path: "/v1/internal/x", why: "a worker callback" }];
  const overrides = { contractRoutes: { exempt } };
  assert.deepEqual((await checked({ contract: CONTRACT, triggerSource: extra.source, overrides })).problems, []);
  const stale = await checked({ contract: CONTRACT, overrides });
  assert.deepEqual(stale.problems.map((problem) => problem.rule), ["stale-route-exemption"]);
});

test("the contract path is the top-level `contract`, and an unreadable contract is a problem", async () => {
  const moved = await checked({ contract: CONTRACT, overrides: { contract: "api/spec.yaml" } });
  assert.deepEqual(moved.problems, []);
  const broken = await checked({ contract: "paths: [unclosed" });
  assert.deepEqual(broken.problems.map((problem) => problem.rule), ["unreadable-contract"]);
});

const rulesOf = (problems) => problems.map((problem) => problem.rule);
const exemptCheck = (exempt) => checkContractRoutes(declaredTriggerRoutes([trigger]), operations, { contract: "c.yaml", exempt });

test("an exemption with no why, or an empty one, fails as exemption-without-reason", () => {
  assert.deepEqual(rulesOf(exemptCheck([{ method: "post", path: "/v1/internal/x" }])), ["exemption-without-reason"]);
  assert.deepEqual(rulesOf(exemptCheck([{ method: "post", path: "/v1/internal/x", why: "  " }])), ["exemption-without-reason"]);
  const [problem] = exemptCheck([{ method: "post", path: "/v1/internal/x" }]);
  assert.equal(problem.path, "qc.config.json");
});

test("a malformed exemption is a problem, not a TypeError, and excuses nothing", () => {
  for (const bad of [{ method: "get" }, { path: "/v1/x", why: "w" }, { method: 5, path: "/v1/x", why: "w" }, null, "get /v1/x", 7]) {
    assert.deepEqual(rulesOf(exemptCheck([bad])), ["malformed-exemption"], JSON.stringify(bad));
  }
  const routes = declaredTriggerRoutes([{ path: "t.ts", source: '{ method: "post", path: "/v1/internal/x" }' }]);
  const problems = checkContractRoutes(routes, [], { contract: "c.yaml", exempt: [{ method: "post", why: "w" }] });
  assert.deepEqual(rulesOf(problems).sort(), ["malformed-exemption", "route-not-in-contract"]);
});

test("a valid exemption beside a bad one still applies", () => {
  const routes = declaredTriggerRoutes([{ path: "t.ts", source: '{ method: "post", path: "/v1/internal/x" }' }]);
  const exempt = [{ method: "get" }, { method: "post", path: "/v1/internal/x", why: "a worker callback" }];
  assert.deepEqual(rulesOf(checkContractRoutes(routes, [], { contract: "c.yaml", exempt })), ["malformed-exemption"]);
});

test("a route in a line comment or a block comment is not served", () => {
  const source = [
    '  // { method: "get", path: "/v1/photos" },',
    '  /* { method: "post", path: "/v1/photos/:photoId/derivatives" } */',
    '  { method: "get", path: "/v1/live", note: "see http://example.test/a" }, // trailing { method: "get", path: "/v1/gone" }',
  ].join("\n");
  assert.deepEqual(declaredTriggerRoutes([{ path: "t.ts", source }]).map(({ path: route }) => route), ["/v1/live"]);
});

test("a commented route next to its contract operation fails as operation-not-served", () => {
  const source = '// { method: "get", path: "/v1/photos" },\n  { method: "post", path: "/v1/photos/:photoId/derivatives" },';
  const problems = check(declaredTriggerRoutes([{ path: "t.ts", source }]), operations);
  assert.deepEqual(rulesOf(problems), ["operation-not-served"]);
  assert.match(problems[0].detail, /get \/v1\/photos/);
});

test("qc check reports a non-array exempt and a bad entry instead of throwing", async () => {
  const notList = await checked({ contract: CONTRACT, overrides: { contractRoutes: { exempt: "post /v1/x" } } });
  assert.deepEqual(rulesOf(notList.problems), ["malformed-exemption"]);
  const missing = await checked({ contract: CONTRACT, overrides: { contractRoutes: { exempt: [{ method: "get" }] } } });
  assert.deepEqual(rulesOf(missing.problems), ["malformed-exemption"]);
  const noReason = await checked({ contract: CONTRACT, overrides: { contractRoutes: { exempt: [{ method: "get", path: "/x" }] } } });
  assert.deepEqual(rulesOf(noReason.problems), ["exemption-without-reason"]);
});

// Known limit: the comment stripper pairs quotes and does not read regex literals, so a quote inside
// one flips the pairing and a commented route after it is still read. This pins today's behaviour.
test("known limit: a quote inside a regex literal lets a later commented route count", () => {
  const source = 'const re = /"/;\n// { method: "get", path: "/v1/photos" },';
  assert.deepEqual(declaredTriggerRoutes([{ path: "t.ts", source }]).map(({ path: route }) => route), ["/v1/photos"]);
});

test("the agreement line is printed only when the gate finds no problem", async () => {
  const agreed = await checked({ contract: CONTRACT });
  assert.ok(agreed.lines.some((line) => line.startsWith("OK  contract ")));
  const drifted = await checked({ contract: CONTRACT.replace("/v1/photos:", "/v1/pictures:") });
  assert.equal(drifted.lines.some((line) => line.startsWith("OK  contract ")), false);
});
