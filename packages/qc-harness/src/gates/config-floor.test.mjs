import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkConfigFloor, exemptionIds, switchedOff } from "./config-floor.mjs";

const shipped = { gates: { citations: true, "english-source": true }, rules: { "no-promise-then": true } };
const allOn = { gates: { citations: true, "english-source": true }, rules: { "no-promise-then": true } };

test("a repository running every shipped check has no findings", () => {
  assert.deepEqual(checkConfigFloor(shipped, allOn), []);
});

test("switching a shipped check off without a reason is a finding", () => {
  const off = { gates: { citations: true, "english-source": false }, rules: allOn.rules };
  const [problem] = checkConfigFloor(shipped, off);
  assert.equal(problem.rule, "unexempted-opt-out");
  assert.match(problem.detail, /gates\.english-source is switched off/);
});

test("a decision id makes the opt-out legitimate", () => {
  const off = { gates: { citations: true, "english-source": false }, rules: allOn.rules };
  assert.deepEqual(checkConfigFloor(shipped, off, { exemptions: { "english-source": "QC-011" } }), []);
});

test("a rule that cannot apply to this repository's shape says so by name", () => {
  const off = { gates: { citations: true, "english-source": false }, rules: allOn.rules };
  assert.deepEqual(checkConfigFloor(shipped, off, { exemptions: { "english-source": "off-by-design" } }), []);
});

test("prose in place of a decision id is refused, so the escape hatch stays narrow", () => {
  const off = { gates: { citations: true, "english-source": false }, rules: allOn.rules };
  const [problem] = checkConfigFloor(shipped, off, { exemptions: { "english-source": "we will do it later" } });
  assert.match(problem.detail, /neither a decision id nor/);
});

test("a lint rule switched off is held to the same floor as a gate", () => {
  const off = { gates: allOn.gates, rules: { "no-promise-then": false } };
  assert.equal(checkConfigFloor(shipped, off)[0].detail.startsWith("rules.no-promise-then"), true);
});

test("an exemption for a check that is on is stale and must be deleted", () => {
  const [problem] = checkConfigFloor(shipped, allOn, { exemptions: { citations: "QC-011" } });
  assert.equal(problem.rule, "stale-exemption");
});

test("a check the kit does not ship on is not held to the floor", () => {
  const optional = { gates: { citations: true, extra: false }, rules: {} };
  assert.deepEqual(switchedOff(optional.gates, { citations: true, extra: false }), []);
});

test("cited ids are collected for the citations gate, and off-by-design is not one", () => {
  assert.deepEqual(exemptionIds({ a: "QC-011", b: "off-by-design", c: "ADR-0031" }), ["QC-011", "ADR-0031"]);
});
