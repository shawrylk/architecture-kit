import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaults, load, merge, requiredHooks } from "./config.mjs";
import { rules } from "./eslint/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("check defaults leave repository commands off", () => {
  assert.equal(defaults.check.sincePush, null);
  assert.equal(defaults.check.e2e, null);
  assert.deepEqual(load(here).check, { related: null, sincePush: null, e2e: null, commands: [], base: "origin/main" });
});

test("check configuration accepts commands and preserves omitted defaults", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "qc-check-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const check = { related: "pnpm exec vitest related --run", commands: ["node script/check-comments.mjs --base origin/dev"] };
  writeFileSync(path.join(root, "qc.config.json"), JSON.stringify({ check }));
  assert.deepEqual(load(root).check, { ...check, sincePush: null, e2e: null, base: "origin/main" });
});

test("check configuration rejects invalid types and empty commands or refs", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "qc-check-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const check of [null, [], false, "command"]) {
    writeFileSync(path.join(root, "qc.config.json"), JSON.stringify({ check }));
    assert.throws(() => load(root), /check must be an object/);
  }
  for (const [key, values] of Object.entries({
    related: [false, 1, [], {}, "", "  "],
    sincePush: [false, 1, [], {}, "", "  "],
    e2e: [false, 1, [], {}, "", "  "],
    commands: [null, false, "node", [1], [null], [""], ["  "]],
    base: [null, false, 1, [], "", "  "],
  })) {
    for (const value of values) {
      writeFileSync(path.join(root, "qc.config.json"), JSON.stringify({ check: { [key]: value } }));
      assert.throws(() => load(root), new RegExp(`check\\.${key}`));
    }
  }
});

// A switch naming a rule that no longer exists silently stops switching anything.
// This is the test that catches the next rename, not the last one.
test("every lint rule has a switch, and every switch names a rule", () => {
  assert.deepEqual(Object.keys(defaults.rules).sort(), Object.keys(rules).sort());
});

// A module under gates/ that no run and no codegen calls: a reader that gates share.
const libraries = ["call-args", "contract-operations", "scrub"];

test("every gate is either switchable, a generator, or a named library", () => {
  const files = readdirSync(path.join(here, "gates"))
    .filter((file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs"))
    .map((file) => file.replace(/\.mjs$/, ""))
    .sort();
  const accounted = [...Object.keys(defaults.gates), ...defaults.generators, ...libraries].sort();
  assert.deepEqual(accounted, files);
});

test("a library is neither a switch nor a generator", () => {
  for (const library of libraries) {
    assert.equal(defaults.gates[library], undefined);
    assert.ok(!defaults.generators.includes(library));
  }
});

// A switch that turns nothing off is worse than no switch: it says the config
// controls something it does not. Every name under `gates` must reach the runner.
test("every switch under gates is one the check runner reads", async () => {
  const source = await readFile(path.join(here, "cli/check.mjs"), "utf8");
  for (const gate of Object.keys(defaults.gates)) {
    assert.ok(
      source.includes(`"${gate}"`),
      `gates.${gate} is never consulted by the check runner`,
    );
  }
});

test("a generator is not offered as a switch", () => {
  for (const generator of defaults.generators) {
    assert.equal(defaults.gates[generator], undefined);
  }
});

test("a user config overrides a key without dropping its siblings", () => {
  const merged = merge(defaults, { tenant: { column: "orgId" } });
  assert.equal(merged.tenant.column, "orgId");
  assert.equal(merged.tenant.tableFactory, defaults.tenant.tableFactory);
});

test("an array replaces rather than merges", () => {
  const merged = merge(defaults, { featureRoots: ["src/features"] });
  assert.deepEqual(merged.featureRoots, ["src/features"]);
});

test("a repository with no config file loads the reference layout", () => {
  const config = load(here);
  assert.deepEqual(config.featureRoots, defaults.featureRoots);
});

test("the tenant isolation helper is unset and its gate ships off", () => {
  assert.equal(defaults.tenant.isolationHelper, null);
  assert.equal(defaults.gates["tenant-isolation-test"], false);
});

test("requiredHooks drops commit-msg only when conventional is false", () => {
  assert.deepEqual(defaults.hooks.required["commit-msg"], ["qc commit-msg"]);
  assert.deepEqual(requiredHooks(defaults)["commit-msg"], ["qc commit-msg"]);
  const off = { ...defaults, commitMessage: { ...defaults.commitMessage, conventional: false } };
  assert.deepEqual(requiredHooks(off), { ...defaults.hooks.required, "commit-msg": [] });
  assert.deepEqual(defaults.hooks.required["commit-msg"], ["qc commit-msg"], "the shipped map is not mutated");
  assert.deepEqual(requiredHooks({ hooks: { required: { "pre-push": ["qc check"] } } }), { "pre-push": ["qc check"] });
});

test("extraExemptHelpers defaults to an empty list, and exemptHelpers keeps the kit defaults", () => {
  assert.deepEqual(defaults.tenantPredicate.extraExemptHelpers, []);
  assert.deepEqual(
    defaults.tenantPredicate.exemptHelpers.map((helper) => helper.name),
    ["insertReturning", "updateVersionedRow"],
  );
  const config = load(here);
  assert.deepEqual(config.tenantPredicate.extraExemptHelpers, []);
  assert.equal(config.tenantPredicate.exemptHelpers.length, 2);
});
