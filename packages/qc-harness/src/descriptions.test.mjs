import test from "node:test";
import assert from "node:assert/strict";
import { gateDescriptions, describedGates } from "./descriptions.mjs";
import { defaults } from "./config.mjs";
import { rules } from "./eslint/index.mjs";

test("every gate the kit ships is described", () => {
  const missing = Object.keys(defaults.gates).filter((name) => gateDescriptions[name] === undefined);
  assert.deepEqual(missing, []);
});

test("a description that names a gate the kit does not ship fails", () => {
  const stale = describedGates().filter((name) => defaults.gates[name] === undefined);
  assert.deepEqual(stale, []);
});

test("every lint rule the kit ships carries its own one-line description", () => {
  const missing = Object.keys(defaults.rules).filter(
    (name) => typeof rules[name]?.meta?.docs?.description !== "string",
  );
  assert.deepEqual(missing, []);
});

test("a description is one line, so a generated map cannot grow a paragraph", () => {
  const multiline = Object.entries(gateDescriptions).filter(([, text]) => text.includes("\n"));
  assert.deepEqual(multiline, []);
});
