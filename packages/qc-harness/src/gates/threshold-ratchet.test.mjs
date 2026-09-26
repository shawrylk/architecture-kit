import test from "node:test";
import assert from "node:assert/strict";
import { checkThresholdRatchet } from "./threshold-ratchet.mjs";

const REGISTRY = "quality-thresholds.json";
const base = {
  filelength: { value: 500, comparator: "max" },
  coverage: { value: 70, comparator: "min" },
};
const moved = (key, value) => ({ ...base, [key]: { ...base[key], value } });
const check = (after, adrs = []) => checkThresholdRatchet(base, after, adrs, { registry: REGISTRY });

test("a max that rises fails", () => {
  const problems = check(moved("filelength", 550));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "loosened-threshold");
  assert.equal(problems[0].path, REGISTRY);
  assert.match(problems[0].detail, /filelength.*500.*550/);
});

test("a min that falls fails", () => {
  assert.equal(check(moved("coverage", 60))[0].rule, "loosened-threshold");
});

test("a changed ADR whose text names the key lets the loosening through", () => {
  const adrs = [{ path: "docs/decisions/0031-longer-files.md", text: "We raise `filelength` to 550." }];
  assert.deepEqual(check(moved("filelength", 550), adrs), []);
});

test("an ADR that names another key does not", () => {
  const adrs = [{ path: "docs/decisions/0031-coverage.md", text: "The coverage floor and filelengths stay." }];
  assert.equal(check(moved("filelength", 550), adrs).length, 1);
});

test("a tightening passes", () => {
  assert.deepEqual(check({ ...moved("filelength", 450), coverage: { value: 80, comparator: "min" } }), []);
});

test("a new entry passes", () => {
  assert.deepEqual(check({ ...base, nesting: { value: 9, comparator: "max" } }), []);
});

test("the comparator in force at the base judges the change", () => {
  const after = { ...base, filelength: { value: 550, comparator: "min" } };
  assert.equal(check(after).length, 1);
});
