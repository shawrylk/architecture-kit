import { strict as assert } from "node:assert";
import { test } from "node:test";
import { assignTick } from "./fleet-assign.mjs";
import { ownerOf } from "./fleet.mjs";

const now = 100_000;
const node = (id, extra = {}) => ({ id, weight: 1, maxSize: "L", active: true, address: "localhost", ...extra });
const row = (number, labels = [], size = "M") => ({ number, size, labels: labels.map(name => ({ name })) });
const base = { fleet: { self: "a", nodes: [node("a"), node("b")] }, repo: "o/r", kit: "kit", now,
  open: new Set([1, 2, 3]), free: [row(1), row(3, ["ci-red"]), row(2)], assignments: {}, peers: { b: { time: now, kit: "kit" } } };
const saved = (issue, node = "b", repo = "o/r") => ({ repo, issue, node, epoch: 1, time: 42 });

test("tick is pure, sorts ci-red then issue number, hashes only idle nodes, and resends remote assignments", () => {
  const input = structuredClone(base), before = structuredClone(input);
  const result = assignTick(input);
  const first = ownerOf("o/r", 3, "M", base.fleet.nodes), second = first === "a" ? "b" : "a";
  assert.deepEqual(result.assignments, { "o/r#3": { ...saved(3, first), time: now }, "o/r#1": { ...saved(1, second), time: now } });
  assert.deepEqual(result.messages, [{ node: "b", kind: "assign", body: { issue: first === "b" ? 3 : 1, epoch: 1 } }]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(input, before);
  assert.deepEqual(assignTick({ ...input, assignments: result.assignments }).messages, result.messages);
});

test("open assignments persist even when busy, stale or drifted; closed issues release their node", () => {
  const assignments = { "o/r#1": saved(1), "o/r#9": saved(9, "a"), "else/r#7": saved(7, "c", "else/r") };
  const result = assignTick({ ...base, assignments, free: [row(1), row(2)], peers: {} });
  assert.deepEqual(result.assignments["o/r#1"], assignments["o/r#1"]);
  assert.deepEqual(result.assignments["else/r#7"], assignments["else/r#7"]);
  assert.equal(result.assignments["o/r#9"], undefined);
  assert.equal(result.assignments["o/r#2"].node, "a");
  assert.deepEqual(assignTick({ ...base, open: new Set(), free: [], assignments }).assignments, { "else/r#7": assignments["else/r#7"] });
});

test("liveness has an inclusive 90 second boundary; self is always live; drift warns and blocks new work", () => {
  for (const [extra, peer, expected] of [
    [{}, { time: now - 90_000, kit: "kit" }, true], [{}, { time: now - 90_001, kit: "kit" }, false],
    [{}, undefined, false], [{ active: false }, { time: now, kit: "kit" }, false],
    [{ address: undefined }, { time: now, kit: "kit" }, false], [{}, { time: now + 1, kit: "kit" }, false],
    [{}, { time: now, kit: "old" }, false],
  ]) {
    const result = assignTick({ ...base, fleet: { self: "a", nodes: [node("a", { maxSize: "S" }), node("b", extra)] },
      open: new Set([1]), free: [row(1)], peers: peer ? { b: peer } : {} });
    assert.equal(Boolean(result.assignments["o/r#1"]), expected);
    assert.deepEqual(result.warnings, peer?.kit === "old" ? ["node b runs kit old, leader runs kit"] : []);
    const repeat = assignTick({ ...base, fleet: { ...base.fleet, nodes: [node("a"), node("b", extra)] },
      assignments: { "o/r#1": saved(1) }, free: [], peers: peer ? { b: peer } : {} });
    assert.deepEqual(repeat.messages, expected || peer?.kit === "old"
      ? [{ node: "b", kind: "assign", body: { issue: 1, epoch: 1 } }] : []);
  }
  const self = assignTick({ ...base, fleet: { self: "a", nodes: [node("a", { active: false, address: undefined })] }, peers: {}, free: [row(1)] });
  assert.equal(self.assignments["o/r#1"].node, "a");
});

test("skip ownerless and non-open rows, then assign the lowest eligible number", () => {
  const result = assignTick({ ...base, fleet: { self: "a", nodes: [node("a", { maxSize: "S" })] },
    free: [row(0, [], "S"), row(1, ["ci-red"], "L"), row(3, [], "S"), row(2, [], "S")] });
  assert.deepEqual(Object.keys(result.assignments), ["o/r#2"]);
});
