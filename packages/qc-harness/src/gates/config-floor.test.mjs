import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkConfigFloor, droppedHelpers, exemptionIds, switchedOff } from "./config-floor.mjs";

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

test("a weakened hooks.required entry is an opt-out, held to the same floor", () => {
  const shipped = { gates: {}, rules: {}, hooks: { required: { "pre-commit": ["qc work-order-check"], "pre-push": ["qc check"] } } };
  const weakened = { gates: {}, rules: {}, hooks: { required: { "pre-commit": ["qc work-order-check"], "pre-push": [] } } };
  const problems = checkConfigFloor(shipped, weakened);
  assert.deepEqual(problems.map((problem) => problem.rule), ["unexempted-opt-out"]);
  assert.match(problems[0].detail, /^hooks\.pre-push is switched off/);
  assert.deepEqual(checkConfigFloor(shipped, weakened, { exemptions: { "hooks.pre-push": "off-by-design" } }), []);
  assert.deepEqual(checkConfigFloor(shipped, shipped, { exemptions: { "hooks.pre-push": "off-by-design" } }).map((p) => p.rule), ["stale-exemption"]);
});

test("conventional false does not report hooks.commit-msg as weakened; emptying it while conventional is on does", () => {
  const hooks = { required: { "pre-push": ["qc check"], "commit-msg": ["qc commit-msg"] } };
  const shipped = { gates: {}, rules: {}, hooks, commitMessage: { conventional: true } };
  const emptied = { gates: {}, rules: {}, hooks: { required: { "pre-push": ["qc check"], "commit-msg": [] } } };
  assert.deepEqual(checkConfigFloor(shipped, { ...emptied, commitMessage: { conventional: false } }), []);
  const [problem] = checkConfigFloor(shipped, { ...emptied, commitMessage: { conventional: true } });
  assert.match(problem.detail, /^hooks\.commit-msg is switched off/);
});

const crud = "backend/src/application/sql/crud.ts";
const insert = { module: crud, name: "insertReturning", argument: 2 };
const update = { module: crud, name: "updateVersionedRow", argument: 3 };
const shippedHelpers = { gates: {}, rules: {}, tenantPredicate: { exemptHelpers: [insert, update] } };
const withHelpers = (exemptHelpers, extraExemptHelpers = []) => ({
  gates: {},
  rules: {},
  tenantPredicate: { exemptHelpers, extraExemptHelpers },
});

test("a config whose exemptHelpers omits a default reports that default by name", () => {
  const problems = checkConfigFloor(shippedHelpers, withHelpers([insert]));
  assert.deepEqual(problems.map((problem) => problem.rule), ["dropped-default-helper"]);
  assert.match(problems[0].detail, /updateVersionedRow/);
  assert.match(problems[0].detail, /backend\/src\/application\/sql\/crud\.ts/);
  assert.match(problems[0].detail, /extraExemptHelpers/);
  assert.equal(problems[0].path, "qc.config.json");
});

test("a config with only extraExemptHelpers reports nothing", () => {
  const extra = { module: "backend/src/application/sql/bulk.ts", name: "insertMany", argument: 1 };
  assert.deepEqual(checkConfigFloor(shippedHelpers, withHelpers([insert, update], [extra])), []);
});

test("an entry matches on module and name, so a same-named helper in another module does not stand in", () => {
  const other = { module: "backend/src/other/crud.ts", name: "updateVersionedRow", argument: 3 };
  assert.deepEqual(droppedHelpers(shippedHelpers.tenantPredicate.exemptHelpers, [insert, other]), [update]);
  assert.deepEqual(droppedHelpers(shippedHelpers.tenantPredicate.exemptHelpers, [update, insert]), []);
});

test("a dropped default with a decision id, or off-by-design, is a deliberate choice", () => {
  const dropped = withHelpers([insert]);
  const key = "tenantPredicate.updateVersionedRow";
  assert.deepEqual(checkConfigFloor(shippedHelpers, dropped, { exemptions: { [key]: "QC-011" } }), []);
  assert.deepEqual(checkConfigFloor(shippedHelpers, dropped, { exemptions: { [key]: "off-by-design" } }), []);
  const [prose] = checkConfigFloor(shippedHelpers, dropped, { exemptions: { [key]: "later" } });
  assert.match(prose.detail, /neither a decision id nor/);
});

test("an exemption for a default the config still lists is stale", () => {
  const [problem] = checkConfigFloor(shippedHelpers, withHelpers([insert, update]), {
    exemptions: { "tenantPredicate.updateVersionedRow": "QC-011" },
  });
  assert.equal(problem.rule, "stale-exemption");
});

test("a config with no tenantPredicate block reports every shipped helper", () => {
  const problems = checkConfigFloor(shippedHelpers, { gates: {}, rules: {} });
  assert.equal(problems.length, 2);
});
