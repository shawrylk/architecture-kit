import test from "node:test";
import assert from "node:assert/strict";
import { checkClosedSetWriters, matchedKeys } from "./closed-set-writers.mjs";

const set = {
  name: "AUDIT_ACTIONS",
  source: "audit/types.ts",
  key: '\\{ key: "([a-z_.]+)", category:',
  writer: 'record\\([\\s\\S]{0,400}?action: "([a-z_.]+)"',
  declaredAhead: { "role.rename": "roles are fixed" },
};

const declared = matchedKeys('[{ key: "pin.create", category: "pin" }, { key: "role.rename", category: "role" }]', set.key);

test("a key and its writer are read by the configured patterns", () => {
  assert.deepEqual(declared, ["pin.create", "role.rename"]);
  assert.deepEqual(matchedKeys('await record(tx, {\n  action: "pin.create",\n});', set.writer), ["pin.create"]);
});

test("every key written, or waiting with its reason, passes", () => {
  assert.deepEqual(checkClosedSetWriters(declared, new Set(["pin.create"]), set), []);
});

test("a key with no writer and no reason fails", () => {
  const problems = checkClosedSetWriters(declared, new Set(), set);
  assert.deepEqual(problems.map((problem) => problem.rule), ["unwritten-key"]);
  assert.equal(problems[0].path, "audit/types.ts");
  assert.match(problems[0].detail, /pin\.create is declared in AUDIT_ACTIONS/);
});

test("a waiting entry that is written now, or no longer declared, fails", () => {
  const written = checkClosedSetWriters(declared, new Set(["pin.create", "role.rename"]), set);
  assert.deepEqual(written.map((problem) => problem.rule), ["stale-declared-ahead"]);
  const gone = checkClosedSetWriters(["pin.create"], new Set(["pin.create"]), set);
  assert.deepEqual(gone.map((problem) => problem.rule), ["stale-declared-ahead"]);
});

test("a writer that writes a key outside the set fails", () => {
  const problems = checkClosedSetWriters(declared, new Set(["pin.create", "pin.explode"]), set);
  assert.deepEqual(problems.map((problem) => problem.rule), ["undeclared-write"]);
});

test("a set whose source declares no key fails, since it checks nothing", () => {
  const problems = checkClosedSetWriters([], new Set(), { ...set, declaredAhead: {} });
  assert.deepEqual(problems.map((problem) => problem.rule), ["empty-closed-set"]);
});
