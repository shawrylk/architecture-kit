import test from "node:test";
import assert from "node:assert/strict";
import { checkGatesAreTested } from "./gate-tests.mjs";

const checks = [{ path: "scripts/gate/tenant-rules.mjs", contents: "export function checkTenantRules() {}" }];

test("a gate no test names fails", () => {
  const problems = checkGatesAreTested(checks, []);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "unproven-gate");
});

test("a test naming the file stem is enough", () => {
  const tests = [{ path: "a.test.mjs", contents: 'import x from "./tenant-rules.mjs";' }];
  assert.deepEqual(checkGatesAreTested(checks, tests), []);
});

test("a test naming an exported function is enough", () => {
  const tests = [{ path: "a.test.mjs", contents: "checkTenantRules([], []);" }];
  assert.deepEqual(checkGatesAreTested(checks, tests), []);
});

test("a repository with no gates of its own has nothing to prove", () => {
  assert.deepEqual(checkGatesAreTested([], []), []);
});

// A stem is an English word as often as it is a filename. Matching it bare read a
// gate as proven because an unrelated test happened to contain the word.
test("a stem that appears only as prose does not prove a gate", () => {
  const checks = [{ path: "scripts/gate/nothing.mjs", contents: "export function checkNothing() { return []; }" }];
  const tests = [{ path: "other.test.mjs", contents: 'test("a source with no table yields nothing", () => {});' }];
  const problems = checkGatesAreTested(checks, tests);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "unproven-gate");
});

test("a stem in an import path still proves it", () => {
  const checks = [{ path: "scripts/gate/nothing.mjs", contents: "export function checkNothing() { return []; }" }];
  const tests = [{ path: "a.test.mjs", contents: 'import { checkNothing } from "./nothing.mjs";' }];
  assert.deepEqual(checkGatesAreTested(checks, tests), []);
});
