import test from "node:test";
import assert from "node:assert/strict";
import { checkRegistryReaders } from "./registry-readers.mjs";

const READER = "frontend/src/platform/gesture-thresholds.ts";
const entries = [{ key: "holdpress", names: ["HOLD_\\w*MS"], readers: [READER] }];

test("a reader that reads the entry through the registry accessor passes", () => {
  const sources = new Map([[READER, "export const HOLD_PRESS_MS = registry.gates.holdpress.value;"]]);
  assert.deepEqual(checkRegistryReaders(entries, sources), []);
});

test("a reader that names the entry key as a string passes", () => {
  const sources = new Map([[READER, 'export const HOLD_PRESS_MS = threshold("holdpress");']]);
  assert.deepEqual(checkRegistryReaders(entries, sources), []);
});

test("a missing reader fails the gate", () => {
  const problems = checkRegistryReaders(entries, new Map([[READER, null]]));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "missing-reader");
  assert.equal(problems[0].path, READER);
  assert.match(problems[0].detail, /holdpress/);
});

test("a reader that never names the entry key fails the gate", () => {
  const sources = new Map([[READER, "export const HOLD_PRESS_MS = registry.gates.holdpressure.value;"]]);
  const problems = checkRegistryReaders(entries, sources);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "silent-reader");
});

test("an entry with no readers has nothing to check", () => {
  assert.deepEqual(checkRegistryReaders([{ key: "dragslop", names: ["\\w*_PX"], readers: [] }], new Map()), []);
});
