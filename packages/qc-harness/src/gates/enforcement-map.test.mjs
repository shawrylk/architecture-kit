import test from "node:test";
import assert from "node:assert/strict";
import { checkEnforcementMap } from "./enforcement-map.mjs";

const RULES = ["no-raw-fetch"];
const GATES = ["citations"];
const complete = "| One module calls fetch | `qc/no-raw-fetch` |\n| Cited ids resolve | `qc check` (citations) |";

test("a map naming every check, and only real ones, passes", () => {
  assert.deepEqual(checkEnforcementMap(complete, RULES, GATES), []);
});

// The failure this exists for: a rule renamed in code, still listed under the old name.
test("a row naming a rule that no longer exists fails", () => {
  const stale = "| Storage in resource | `qc/drizzle-only-in-resource` |\n| Cited ids resolve | `qc check` (citations) |";
  const problems = checkEnforcementMap(stale, ["storage-only-in-resource"], GATES);
  assert.ok(problems.some((p) => p.rule === "unknown-check" && p.detail.includes("drizzle-only-in-resource")));
});

test("a row naming a gate that does not exist fails", () => {
  const problems = checkEnforcementMap("| x | `qc check` (nonesuch) |", [], GATES);
  assert.ok(problems.some((p) => p.rule === "unknown-check" && p.detail.includes("nonesuch")));
});

test("a check the map never mentions fails", () => {
  const problems = checkEnforcementMap(complete, [...RULES, "signal-last-param"], GATES);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "unlisted-check");
});

test("a third-party check is listed and left alone", () => {
  const foreign = `${complete}\n| No any | \`@typescript-eslint/no-explicit-any\` |\n| Duplication | \`jscpd\` |`;
  assert.deepEqual(checkEnforcementMap(foreign, RULES, GATES), []);
});

test("the completeness half can be turned off", () => {
  const problems = checkEnforcementMap(complete, [...RULES, "signal-last-param"], GATES, {
    requireEveryCheckListed: false,
  });
  assert.deepEqual(problems, []);
});
