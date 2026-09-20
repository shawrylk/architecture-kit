import test from "node:test";
import assert from "node:assert/strict";
import { checkClaimedRequirements, claimedIds } from "./claimed-requirements.mjs";

const trigger = `export const trigger = defineTrigger({
  routes: [
    { method: "get", path: "/v1/a", auth: "tenant", req: ["REQ-PRJ-001", "REQ-PRJ-002"], handler: a },
    { method: "post", path: "/v1/b", auth: "public", req: ["REQ-PRJ-003"], handler: b },
  ],
});`;

test("every id a route claims is collected", () => {
  assert.deepEqual([...claimedIds(trigger)].sort(), ["REQ-PRJ-001", "REQ-PRJ-002", "REQ-PRJ-003"]);
});

test("a claim backed by a named test passes", () => {
  const tests = new Map([
    ["REQ-PRJ-001", ["a.test.ts"]],
    ["REQ-PRJ-002", ["a.test.ts"]],
    ["REQ-PRJ-003", ["b.test.ts"]],
  ]);
  assert.deepEqual(checkClaimedRequirements([{ path: "t.ts", source: trigger }], tests), []);
});

test("a claim that names no test is a finding", () => {
  const tests = new Map([
    ["REQ-PRJ-001", ["a.test.ts"]],
    ["REQ-PRJ-002", []],
    ["REQ-PRJ-003", ["b.test.ts"]],
  ]);
  const problems = checkClaimedRequirements([{ path: "t.ts", source: trigger }], tests);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "unproven-requirement");
  assert.match(problems[0].detail, /REQ-PRJ-002/);
});

test("a claim on an id nobody registered is a finding", () => {
  const tests = new Map([["REQ-PRJ-001", ["a.test.ts"]], ["REQ-PRJ-002", ["a.test.ts"]]]);
  const problems = checkClaimedRequirements([{ path: "t.ts", source: trigger }], tests);
  assert.deepEqual(problems.map((p) => p.rule), ["unregistered-requirement"]);
});

test("a registered id no route claims is not required to be proven yet", () => {
  const tests = new Map([["REQ-PRJ-001", ["a.test.ts"]], ["REQ-PRJ-002", ["a.test.ts"]], ["REQ-PRJ-003", ["b.test.ts"]], ["REQ-ADM-001", []]]);
  assert.deepEqual(checkClaimedRequirements([{ path: "t.ts", source: trigger }], tests), []);
});

test("a trigger that declares no routes claims nothing", () => {
  assert.deepEqual(claimedIds("export const trigger = defineTrigger({ routes: [], queues: [] });").size, 0);
});

test("the claim key and the id shape come from options", () => {
  const source = 'route({ satisfies: ["STORY-12"] })';
  assert.deepEqual([...claimedIds(source, { key: "satisfies", id: "STORY-\\d+" })], ["STORY-12"]);
});

test("a claim under the default key is invisible to a repository that renamed it", () => {
  const source = 'route({ req: ["REQ-PHO-001"] })';
  assert.deepEqual([...claimedIds(source, { key: "satisfies", id: "STORY-\\d+" })], []);
});
