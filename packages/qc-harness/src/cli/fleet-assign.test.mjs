import { strict as assert } from "node:assert";
import { test } from "node:test";
import { assignTick, overloaded } from "./fleet-assign.mjs";
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
  assert.deepEqual(result.assignments, { "o/r#3": { ...saved(3, first), time: now, size: "M" }, "o/r#1": { ...saved(1, second), time: now, size: "M" } });
  assert.deepEqual(result.messages, [{ node: "b", kind: "assign", body: { issue: first === "b" ? 3 : 1, epoch: 1 } }]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(input, before);
  assert.deepEqual(assignTick({ ...input, assignments: result.assignments }).messages, result.messages);
});

test("open live assignments persist even when busy or drifted; closed issues release their node", () => {
  const assignments = { "o/r#1": saved(1), "o/r#9": saved(9, "a"), "else/r#7": saved(7, "c", "else/r") };
  const result = assignTick({ ...base, assignments, free: [row(1), row(2)], peers: { b: { time: now, kit: "old" } } });
  assert.deepEqual(result.assignments["o/r#1"], assignments["o/r#1"]);
  assert.deepEqual(result.assignments["else/r#7"], assignments["else/r#7"]);
  assert.equal(result.assignments["o/r#9"], undefined);
  assert.equal(result.assignments["o/r#2"].node, "a");
  assert.deepEqual(assignTick({ ...base, open: new Set(), free: [], assignments }).assignments, { "else/r#7": assignments["else/r#7"] });
});

test("liveness expires at the 90 second boundary; self is always live; drift warns and blocks new work", () => {
  for (const [extra, peer, expected] of [
    [{}, { time: now - 89_999, kit: "kit" }, true], [{}, { time: now - 90_000, kit: "kit" }, false], [{}, { time: now - 90_001, kit: "kit" }, false],
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

test("three nodes: move dead work at 90 seconds, bump epoch and carry matching work only", () => {
  const fleet = { self: "a", nodes: [node("a"), node("b"), node("c")] };
  const assignments = { "o/r#1": saved(1, "b"), "o/r#2": saved(2, "a") };
  const work = { repo: "o/r", issue: 1, epoch: 1, step: "code", branch: "feat/1-old", head: "a".repeat(40) };
  const input = { ...base, fleet, assignments, free: [], peers: {
    b: { time: now - 90_000, kit: "kit", work: [work] }, c: { time: now, kit: "kit" },
  } };
  const before = structuredClone(input);
  const result = assignTick(input);
  assert.deepEqual(result.assignments["o/r#1"], { ...saved(1, "c"), epoch: 2, time: now, branch: work.branch, head: work.head });
  assert.deepEqual(result.messages, [{ node: "c", kind: "assign", body: { issue: 1, epoch: 2, branch: work.branch, head: work.head } }]);
  assert.deepEqual(result.assignments["o/r#2"], assignments["o/r#2"]);
  assert.deepEqual(input, before);
  const fresh = assignTick({ ...input, peers: { ...input.peers, b: { ...input.peers.b, time: now - 89_999 } } });
  assert.equal(fresh.assignments["o/r#1"].node, "b");
  for (const fields of [{ branch: "feat/1-old" }, { head: "a".repeat(40) }, {}]) {
    const { branch: _branch, head: _head, ...rest } = work;
    const moved = assignTick({ ...input, peers: { ...input.peers, b: { ...input.peers.b, work: [{ ...rest, ...fields }] } } });
    assert.deepEqual(moved.messages[0].body, { issue: 1, epoch: 2, ...fields });
  }
  for (const age of [89_999, 90_000]) {
    const result = assignTick({ ...input, assignments: { ...assignments, "o/r#1": { ...assignments["o/r#1"], time: now - age } }, peers: { c: input.peers.c } });
    assert.equal(result.assignments["o/r#1"].node, age === 90_000 ? "c" : "b");
  }
  for (const changed of [{ epoch: 0 }, { repo: "else/r" }, { issue: 9 }]) {
    const moved = assignTick({ ...input, peers: { ...input.peers, b: { ...input.peers.b, work: [{ ...work, ...changed }] } } });
    assert.equal(moved.assignments["o/r#1"].branch, undefined);
    assert.equal(moved.assignments["o/r#1"].head, undefined);
  }
});

test("dead work waits for an idle compatible live owner and takes priority over new work", () => {
  const assignments = { "o/r#1": { ...saved(1), size: "L" }, "o/r#2": saved(2, "a") };
  const input = { ...base, assignments, free: [row(3)], peers: {}, fleet: { self: "a", nodes: [node("a"), node("b"), node("c", { maxSize: "S" })] } };
  const waiting = assignTick({ ...input, peers: { c: { time: now, kit: "kit" } } });
  assert.deepEqual(waiting.assignments, assignments);
  assert.deepEqual(waiting.warnings, ["#1 waits: node b is dead"]);
  const moved = assignTick({ ...input, open: new Set([1, 3]) });
  assert.equal(moved.assignments["o/r#1"].node, "a");
  assert.equal(moved.assignments["o/r#1"].epoch, 2);
  assert.equal(moved.assignments["o/r#3"], undefined);
  assert.deepEqual(moved.warnings, []);
});

test("takeover uses ownerOf, excludes stale candidates, and retains size for taken issues", () => {
  const fleet = { self: "a", nodes: [node("a"), node("b"), node("c")] };
  const assignments = { "o/r#1": { ...saved(1), size: "L" } };
  for (const c of [{ time: now, kit: "kit" }, { time: now - 90_000, kit: "kit" }, { time: now, kit: "old" }]) {
    const result = assignTick({ ...base, fleet, assignments, free: [], peers: { c } });
    const candidates = c.time === now && c.kit === "kit" ? [node("a"), node("c")] : [node("a")];
    assert.equal(result.assignments["o/r#1"].node, ownerOf("o/r", 1, "L", candidates));
  }
  const first = assignTick({ ...base, open: new Set([1]), free: [row(1, [], "L")] });
  assert.equal(first.assignments["o/r#1"].size, "L");
});

test("overload limits are inclusive and unknown values do not count", () => {
  assert.deepEqual(overloaded(), []);
  assert.deepEqual(overloaded({ cpu: null, mem: null, rtt: null }), []);
  assert.deepEqual(overloaded({ cpu: 0.89, mem: 0.89, rtt: 1999 }), []);
  for (const [field, value, reason] of [["cpu", 0.9, "cpu 90%"], ["mem", 0.9, "mem 90%"], ["rtt", 2000, "rtt 2000ms"]]) {
    assert.deepEqual(overloaded({ [field]: value }), [reason]);
  }
  assert.deepEqual(overloaded({ cpu: 0.95, mem: 0.91, rtt: 2100 }), ["cpu 95%", "mem 91%", "rtt 2100ms"]);
});

test("overloaded peers and Leader get no new work or takeover and keep held work", () => {
  for (const id of ["a", "b"]) for (const load of [{ cpu: 0.95 }, { mem: 0.9 }, { rtt: 2000 }]) {
    const input = { ...base, fleet: { self: "a", nodes: [node(id)] }, peers: { [id]: { time: now, kit: "kit", load } } };
    const fresh = assignTick(input);
    assert.deepEqual(fresh.assignments, {});
    assert.deepEqual(fresh.warnings, [`node ${id} is overloaded: ${overloaded(load).join(", ")}`]);
    const held = { "o/r#1": saved(1, id) };
    assert.deepEqual(assignTick({ ...input, assignments: held }).assignments, held);
    const dead = { "o/r#1": saved(1, "dead") };
    assert.deepEqual(assignTick({ ...input, assignments: dead }).assignments, dead);
  }
});
