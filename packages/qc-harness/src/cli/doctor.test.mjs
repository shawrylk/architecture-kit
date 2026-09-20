import { strict as assert } from "node:assert";
import { test } from "node:test";
import { drift, driftReport, gateNames } from "./doctor.mjs";

const installed = { gates: ["citations", "comment-style", "headless-sagas", "test-mirror"], version: "0.3.0" };

test("two copies shipping the same gates at the same version are not drift", () => {
  assert.equal(drift(installed, { ...installed }), null);
});

test("a plugin copy missing gates the lockfile ships is drift, and names them", () => {
  const found = drift(installed, { gates: ["citations", "headless-sagas"], version: "0.3.0" });
  assert.deepEqual(found.missing, ["comment-style", "test-mirror"]);
  assert.deepEqual(found.extra, []);
});

test("the report blames the checkout, never the repository", () => {
  const found = drift(installed, { gates: ["citations"], version: "0.2.0" });
  const report = driftReport(found, "/home/x/kit/packages/qc-harness", "/home/x/kit");
  assert.match(report, /unknown-check for rules your docs correctly list/);
  assert.match(report, /fix the checkout, never the repository: git -C \/home\/x\/kit /);
});

test("a checkout behind the lockfile blocks, because its verdict is about the wrong rulebook", () => {
  const found = drift(installed, { gates: ["citations"], version: "0.3.0" });
  assert.equal(found.blocking, true);
  assert.match(driftReport(found, "/k"), /^FAIL/);
});

test("a checkout ahead does not block: developing the kit is not a broken repository", () => {
  const found = drift(installed, { gates: [...installed.gates, "new-gate"], version: "0.3.0" });
  assert.equal(found.blocking, false);
  const report = driftReport(found, "/k");
  assert.match(report, /^WARN/);
  assert.match(report, /ahead, not stale/);
  assert.doesNotMatch(report, /fix the checkout/);
});

test("a version difference alone is drift, even with identical gates", () => {
  assert.ok(drift(installed, { ...installed, version: "0.2.0" }));
});

test("a plugin copy carrying an unreleased gate is reported as extra, not missing", () => {
  const found = drift(installed, { gates: [...installed.gates, "new-gate"], version: "0.3.0" });
  assert.deepEqual(found.extra, ["new-gate"]);
  assert.deepEqual(found.missing, []);
});

test("nothing to compare is not a failure", () => {
  assert.equal(drift(installed, null), null);
  assert.equal(drift(null, installed), null);
});

test("gate names come from the directory, with the test files excluded", () => {
  const read = () => ["citations.mjs", "citations.test.mjs", "headless-sagas.mjs", "README.md"];
  assert.deepEqual(gateNames(process.cwd(), read), ["citations", "headless-sagas"]);
});
