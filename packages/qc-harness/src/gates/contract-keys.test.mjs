import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parse } from "yaml";
import { checkContractKeys } from "./contract-keys.mjs";

const SPLIT = [
  "components:",
  "  schemas:",
  "    Row:",
  "      type: object",
  "      properties:",
  "        id: { type: string, description: Rows, sorted. }",
  "",
].join("\n");

test("a description split by a comma leaves a dotted key with no value, and both marks fail", () => {
  const problems = checkContractKeys(parse(SPLIT), "api.yaml");
  assert.deepEqual(problems.map((problem) => problem.rule).sort(), ["contract-key-ends-with-dot", "contract-null-value"]);
  for (const problem of problems) assert.ok(problem.detail.startsWith("#/components/schemas/Row/properties/id/sorted."), problem.detail);
});

test("a key with no value fails, outside an example or a default", () => {
  const problems = checkContractKeys(parse("components:\n  schemas:\n    Row:\n      required:\n"), "api.yaml");
  assert.deepEqual(problems.map((problem) => problem.rule), ["contract-null-value"]);
});

test("a quoted description, a null default, a null example, and an extension pass", () => {
  const text = [
    "components:",
    "  schemas:",
    "    Row:",
    "      properties:",
    '        id: { type: string, description: "Rows, sorted." }',
    '        note: { type: [string, "null"], default: null, example: { a: null }, x-note: { b: null } }',
    "",
  ].join("\n");
  assert.deepEqual(checkContractKeys(parse(text), "api.yaml"), []);
});
