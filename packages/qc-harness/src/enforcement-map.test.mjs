import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enforcementMap, withEnforcementMap, OPEN, CLOSE } from "./enforcement-map.mjs";
import { checkEnforcementMap } from "./gates/enforcement-map.mjs";
import { defaults } from "./config.mjs";
import { rules } from "./eslint/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("the template the kit ships passes the kit's own enforcement-map gate", async () => {
  const template = await readFile(path.join(here, "../templates/docs/enforcement.md"), "utf8");
  const filled = withEnforcementMap(template, allOn);
  const problems = checkEnforcementMap(filled, Object.keys(rules), Object.keys(defaults.gates));
  assert.deepEqual(problems, []);
});

// Against an all-on config: a policy gate ships off, and the map states what is in force, so the
// two have to be asked separately -- does every check *reach* the map when enabled.
const allOn = {
  ...defaults,
  gates: Object.fromEntries(Object.keys(defaults.gates).map((name) => [name, true])),
  rules: Object.fromEntries(Object.keys(rules).map((name) => [name, true])),
};

test("a rule the kit adds reaches the map without anyone editing the template", () => {
  const map = enforcementMap(allOn);
  for (const name of Object.keys(rules)) assert.ok(map.includes(`qc/${name}`), name);
  for (const name of Object.keys(defaults.gates)) assert.ok(map.includes(`(${name})`), name);
});

test("a gate the kit ships off is not in the map, because it is not in force", () => {
  const map = enforcementMap(defaults);
  assert.ok(!map.includes("(english-source)"));
  assert.ok(map.includes("(citations)"));
});

test("a switched-off check is not listed, because it is not in force", () => {
  const map = enforcementMap({ ...defaults, rules: { ...defaults.rules, "no-raw-fetch": false } });
  assert.ok(!map.includes("qc/no-raw-fetch"));
});

test("splicing keeps what a repository wrote around the markers", () => {
  const filled = withEnforcementMap(`before\n\n${OPEN}\nstale\n${CLOSE}\n\nafter`, defaults);
  assert.ok(filled.startsWith("before"));
  assert.ok(filled.endsWith("after"));
  assert.ok(!filled.includes("stale"));
});

test("a document with no markers returns null, distinct from a splice that changed nothing", () => {
  assert.equal(withEnforcementMap("no markers here", defaults), null);
});

test("a repository's own annotation on the open marker survives the splice", () => {
  const filled = withEnforcementMap(`before\n\n<!-- generated: rule-to-check. pnpm codegen. -->\nstale\n${CLOSE}\n\nafter`, defaults);
  assert.ok(filled.includes("<!-- generated: rule-to-check. pnpm codegen. -->"));
  assert.ok(!filled.includes("stale"));
});
