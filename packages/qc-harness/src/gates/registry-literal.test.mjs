import test from "node:test";
import assert from "node:assert/strict";
import { checkRegistryLiteral } from "./registry-literal.mjs";

const thresholds = {
  coverage: { value: 70, unit: "percent", comparator: "min", match: ["coverage threshold", "coverage on new code"] },
  filelength: { value: 500, unit: "lines", comparator: "max", match: ["max-lines", "file length"] },
  holdpress: { value: 500, unit: "ms", comparator: "max" },
  maxwarnings: { value: 0, unit: "count", comparator: "max", match: ["max warnings"] },
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

test("an annotated number that matches the registry passes", () => {
  assert.deepEqual(check("Lint runs with 0 <!-- q:maxwarnings --> warnings allowed."), []);
  assert.deepEqual(check("The coverage threshold of 70% <!-- q:coverage --> holds."), []);
  assert.deepEqual(check("The coverage threshold is 70<!--q:coverage--> here."), []);
});

test("an annotated number that is stale fails, naming the entry and the current value", () => {
  const problems = check("Intro.\n\nThe coverage threshold of 60 <!-- q:coverage --> holds.");
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "stale-annotated-number");
  assert.equal(problems[0].path, "docs/architecture.md:3");
  assert.match(problems[0].detail, /'60'/);
  assert.match(problems[0].detail, /'coverage'/);
  assert.match(problems[0].detail, /\b70\b/);
});

test("a bare token still passes", () => {
  assert.deepEqual(check("Lint runs with {{q:maxwarnings}} warnings allowed."), []);
});

test("a bare number near a match phrase still fails", () => {
  assert.deepEqual(rules("The max warnings is 0 for every package."), ["threshold-literal"]);
});

test("an unknown id in an annotation fails", () => {
  const problems = check("Lint runs with 0 <!-- q:nosuch --> warnings allowed.");
  assert.deepEqual(problems.map((problem) => problem.rule), ["unknown-token"]);
  assert.match(problems[0].detail, /q:nosuch/);
});

test("an annotation with no number before it fails", () => {
  assert.deepEqual(rules("The coverage threshold <!-- q:coverage --> holds."), ["annotation-without-number"]);
});

test("an annotation with a prefix no registry owns is a plain comment", () => {
  assert.deepEqual(check("Lint runs with 0 <!-- note:x --> warnings allowed, and 9 <!-- ttl:x --> more."), []);
});

test("a version annotation is checked against the version", () => {
  assert.deepEqual(check("The api runs on Node.js 24 <!-- ver:node --> and Drizzle ORM 0.44 <!-- v:drizzle -->."), []);
  const problems = check("The api runs on Node.js 25 <!-- ver:node -->.");
  assert.deepEqual(problems.map((problem) => problem.rule), ["stale-annotated-number"]);
  assert.match(problems[0].detail, /\b24\b/);
});

const lifetimes = {
  accesstoken: { value: 15, unit: "minutes", match: ["access token lifetime", "token ttl"] },
  offlinegrace: { value: 7, unit: "days", match: ["offline grace"] },
};
const lifetimeRegistry = { prefixes: ["ttl"], entries: lifetimes };
const checkLifetimes = (contents, list = [lifetimeRegistry]) =>
  checkRegistryLiteral([{ path: "docs/auth.md", contents }], { registries: list, exempt: [] });

test("a lifetimes registry with prefix ttl: a bare number fails and an annotated one passes", () => {
  const bare = checkLifetimes("The access token lifetime is 15 minutes.");
  assert.deepEqual(bare.map((problem) => problem.rule), ["threshold-literal"]);
  assert.match(bare[0].detail, /\{\{ttl:accesstoken\}\}/);
  assert.deepEqual(checkLifetimes("The access token lifetime is 15 <!-- ttl:accesstoken --> minutes."), []);
  assert.deepEqual(checkLifetimes("The access token lifetime is {{ttl:accesstoken}}."), []);
  const stale = checkLifetimes("The access token lifetime is 20 <!-- ttl:accesstoken --> minutes.");
  assert.deepEqual(stale.map((problem) => problem.rule), ["stale-annotated-number"]);
});

test("valueKey and unitKey name the fields of a registry", () => {
  const renamed = { prefixes: ["ttl"], entries: { grace: { span: 7, per: "days", match: ["offline grace"] } }, valueKey: "span", unitKey: "per" };
  assert.deepEqual(checkLifetimes("The offline grace is 7 days.", [renamed]).map((problem) => problem.rule), ["threshold-literal"]);
  assert.deepEqual(checkLifetimes("The offline grace is 7 <!-- ttl:grace --> days.", [renamed]), []);
  assert.match(checkLifetimes("The offline grace is 8 <!-- ttl:grace --> days.", [renamed])[0].detail, /\b7\b/);
});

test("every listed prefix is a token and an annotation", () => {
  const list = [lifetimeRegistry, { prefixes: ["q", "t"], entries: thresholds }];
  const text = "Offline grace 7 <!-- ttl:offlinegrace --> days, coverage threshold 70 <!-- q:coverage -->% and 70 <!-- t:coverage -->%.";
  assert.deepEqual(checkLifetimes(text, list), []);
  assert.deepEqual(checkLifetimes("Offline grace {{ttl:offlinegrace}}, coverage threshold {{t:coverage}}.", list), []);
  const stale = checkLifetimes("Offline grace 8 <!-- ttl:offlinegrace --> days, coverage threshold 71 <!-- t:coverage -->%.", list);
  assert.deepEqual(stale.map((problem) => problem.rule), ["stale-annotated-number", "stale-annotated-number"]);
});

test("an entry with no figure under the valueKey is its own problem", () => {
  const bare = { prefixes: ["ttl"], entries: { grace: { label: "Grace" } } };
  const problems = checkLifetimes("Grace is 7 <!-- ttl:grace --> days.", [bare]);
  assert.deepEqual(problems.map((problem) => problem.rule), ["entry-without-value"]);
  assert.match(problems[0].detail, /no 'value'/);
  const renamed = { ...bare, entries: { grace: { value: 7 } }, valueKey: "span" };
  assert.match(checkLifetimes("Grace is 7 <!-- ttl:grace --> days.", [renamed])[0].detail, /no 'span'/);
});
