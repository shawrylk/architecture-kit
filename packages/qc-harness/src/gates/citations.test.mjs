import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkCitations, checkSelfContained, definedIds, citationPattern } from "./citations.mjs";

const LOG = `
| id | decision | rule |
|---|---|---|
| ADR-0047 | eight blocks | one file |
| QC-004 | canvas | instancing |
`;

test("ids are harvested from the decision table", () => {
  const ids = definedIds(LOG);
  assert.ok(ids.has("ADR-0047"));
  assert.ok(ids.has("QC-004"));
  assert.equal(ids.size, 2);
});

test("a defined citation passes", () => {
  const problems = checkCitations(
    [{ path: "a.ts", contents: "// ADR-0047" }],
    definedIds(LOG),
    new Set(),
  );
  assert.deepEqual(problems, []);
});

test("an undefined decision id fails and names it", () => {
  const problems = checkCitations(
    [{ path: "a.ts", contents: "// ADR-9999" }],
    definedIds(LOG),
    new Set(),
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "undefined-decision");
  assert.equal(problems[0].detail, "ADR-9999");
});

test("an undefined requirement id fails", () => {
  const problems = checkCitations(
    [{ path: "a.ts", contents: "// REQ-PHO-003" }],
    definedIds(LOG),
    new Set(["REQ-PIN-001"]),
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "undefined-requirement");
});

const FOREIGN = ["PredecessorProject", "\\.\\./sibling-checkout", "/sibling spec/i"];

test("a reference to another repository fails", () => {
  const problems = checkSelfContained(
    [{ path: "docs/x.md", contents: "see ../PredecessorProject/docs/spec" }],
    FOREIGN,
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "foreign-reference");
});

test("a delimited pattern keeps its flags", () => {
  const problems = checkSelfContained([{ path: "a.md", contents: "the Sibling Spec says" }], FOREIGN);
  assert.equal(problems.length, 1);
});

test("no foreign reference passes", () => {
  assert.deepEqual(checkSelfContained([{ path: "a.ts", contents: "// docs/guards.md" }], FOREIGN), []);
});

test("a repository naming no foreign pattern has nothing to fail", () => {
  assert.deepEqual(checkSelfContained([{ path: "a.ts", contents: "../PredecessorProject" }]), []);
});

test("the citation prefixes and the docs root come from options", () => {
  const defined = definedIds("| RFC-001 | x | y |", { prefixes: ["RFC"] });
  assert.deepEqual([...defined], ["RFC-001"]);
  const problems = checkCitations(
    [{ path: "a.ts", contents: "// RFC-002" }],
    defined,
    new Set(),
    { prefixes: ["RFC"] },
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "undefined-decision");
});

import { checkDocPaths } from "./citations.mjs";

test("a cited doc that exists passes", () => {
  const problems = checkDocPaths(
    [{ path: "a.ts", contents: "// docs/guards.md" }],
    new Set(["docs/guards.md"]),
  );
  assert.deepEqual(problems, []);
});

test("a cited doc that does not exist fails and names it", () => {
  const problems = checkDocPaths(
    [{ path: "a.ts", contents: "// docs/gone.md" }],
    new Set(["docs/guards.md"]),
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "missing-doc");
  assert.equal(problems[0].detail, "docs/gone.md");
});

test("the citation pattern is the one the gate reads, and a tool can rewrite by it", () => {
  const pattern = citationPattern();
  const found = "ADR-0054 and QC-010, not ADR-00544 or REQ-PHO-001".match(pattern);
  assert.deepEqual(found, ["ADR-0054", "QC-010"]);
});

test("the citation pattern honours the prefixes a repository declares", () => {
  const found = "ADR-0001 DEC-0002".match(citationPattern(["DEC"]));
  assert.deepEqual(found, ["DEC-0002"]);
});
