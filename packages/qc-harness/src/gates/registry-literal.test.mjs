import test from "node:test";
import assert from "node:assert/strict";
import { checkRegistryLiteral } from "./registry-literal.mjs";

const thresholds = {
  coverage: { value: 70, unit: "percent", comparator: "min", match: ["coverage threshold", "coverage on new code"] },
  filelength: { value: 500, unit: "lines", comparator: "max", match: ["max-lines", "file length"] },
  holdpress: { value: 500, unit: "ms", comparator: "max" },
};
const libraries = { node: { label: "Node.js", version: "24" }, drizzle: { label: "Drizzle ORM", version: "0.44" } };
const registries = { thresholds, libraries, exempt: ["docs/decisions/**"] };
const check = (contents, file = "docs/architecture.md") => checkRegistryLiteral([{ path: file, contents }], registries);
const rules = (contents) => check(contents).map((problem) => problem.rule);

test("a threshold stated as a number beside its phrase fails", () => {
  const problems = check("Intro.\n\nThe coverage threshold of 70% holds on every package.");
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "threshold-literal");
  assert.equal(problems[0].path, "docs/architecture.md:3");
  assert.match(problems[0].detail, /\{\{q:coverage\}\}/);
});

test("the token passes", () => {
  assert.deepEqual(check("The coverage threshold of {{q:coverage}} holds."), []);
});

test("another number near the phrase passes", () => {
  assert.deepEqual(check("The coverage threshold rose twice in 2024, across 3 packages and 1700 files."), []);
});

test("the number before the phrase, in a table row, fails", () => {
  assert.deepEqual(rules("| 70% | coverage on new code |"), ["threshold-literal"]);
  assert.deepEqual(rules("70 percent coverage on new code"), ["threshold-literal"]);
});

test("a phrase that holds a hyphen matches as a whole word", () => {
  assert.deepEqual(rules("`max-lines` stops at 500 lines."), ["threshold-literal"]);
  assert.deepEqual(check("`max-lines-per-function` stops at 500."), []);
});

test("the unit of another entry keeps the number quiet, and no unit reports it", () => {
  assert.deepEqual(check("The file length check runs in 500 ms."), []);
  assert.deepEqual(rules("The file length is 500."), ["threshold-literal"]);
});

test("a number is whole: an id, a date or a decimal holding the digits passes", () => {
  assert.deepEqual(check("The coverage threshold is in ADR-0070, dated 2026-07-70, at 0.70 weight."), []);
});

test("the window is six words, and a paragraph ends it", () => {
  assert.deepEqual(rules("The coverage threshold is one that we hold at\n70% here."), ["threshold-literal"]);
  assert.deepEqual(check("The coverage threshold is one that we all hold firmly at 70%."), []);
  assert.deepEqual(check("The coverage threshold.\n\n70% of the files."), []);
});

test("a library label beside a version number fails, and its token passes", () => {
  const problems = check("The api runs on Node.js 24 and\nDrizzle ORM 0.44.");
  assert.deepEqual(problems.map((problem) => [problem.rule, problem.path]), [
    ["version-literal", "docs/architecture.md:1"],
    ["version-literal", "docs/architecture.md:2"],
  ]);
  assert.match(problems[0].detail, /\{\{ver:node\}\}/);
  assert.deepEqual(check("The api runs on Node.js {{v:node}} and {{ver:drizzle}}."), []);
});

test("an exempt file passes", () => {
  assert.deepEqual(check("The coverage threshold of 70% on Node.js 24.", "docs/decisions/0001-coverage.md"), []);
});
