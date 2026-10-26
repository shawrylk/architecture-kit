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

test("ci.requiredChecks defaults to an empty list and accepts check names", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "qc-ci-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(load(root).ci, { requiredChecks: [] });
  writeFileSync(path.join(root, "qc.config.json"), JSON.stringify({ ci: { requiredChecks: ["build", "test"] } }));
  assert.deepEqual(load(root).ci.requiredChecks, ["build", "test"]);
});

test("ci.requiredChecks rejects malformed configuration", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "qc-ci-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const ci of [null, [], false, "CI", { requiredChecks: null }, { requiredChecks: "build" }, { requiredChecks: [""] }, { requiredChecks: [" "] }, { requiredChecks: [1] }]) {
    writeFileSync(path.join(root, "qc.config.json"), JSON.stringify({ ci }));
    assert.throws(() => load(root), /ci/);
  }
});

test("featureSwitches validates its object, filename, patterns, and regular expressions", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "qc-switch-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const value of [null, [], false, "switches"]) {
    writeFileSync(path.join(root, "qc.config.json"), JSON.stringify({ featureSwitches: value }));
    assert.throws(() => load(root), /featureSwitches must be an object/);
  }
  for (const [key, values] of Object.entries({
    file: [null, false, 3, [], {}, "", "  ", ".", "..", "nested/switches.ts", "nested\\switches.ts"],
    patterns: [null, false, "SHOW_", {}, [3], [null], ["["], ["("]],
  })) {
    for (const value of values) {
      writeFileSync(path.join(root, "qc.config.json"), JSON.stringify({ featureSwitches: { [key]: value } }));
      assert.throws(() => load(root), new RegExp(`featureSwitches\\.${key}`));
    }
  }
  writeFileSync(path.join(root, "qc.config.json"), JSON.stringify({ featureSwitches: { file: "switches.ts", patterns: ["^CUSTOM_"] } }));
  assert.deepEqual(load(root).featureSwitches, { file: "switches.ts", patterns: ["^CUSTOM_"] });
  writeFileSync(path.join(root, "qc.config.json"), JSON.stringify({ featureSwitches: { patterns: [] } }));
  assert.deepEqual(load(root).featureSwitches.patterns, []);
});

test("featureSwitches validation throws plain TypeErrors with their stacks", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "qc-switch-errors-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const featureSwitches of [null, { file: "" }, { patterns: "SHOW_" }, { patterns: ["["] }]) {
    writeFileSync(path.join(root, "qc.config.json"), JSON.stringify({ featureSwitches }));
    assert.throws(() => load(root), (error) => {
      assert.equal(error.constructor, TypeError);
      assert.equal(error.name, "TypeError");
      assert.match(error.message, /^featureSwitches/);
      assert.match(error.stack, /at load \(/);
      return true;
    });
  }
});

test("codex defaults bound a short session and disable the skill plugin", () => {
  assert.deepEqual(load(here).codex, {
    compactTokens: 300000,
    disablePlugins: ["superpowers@claude-plugins-official"],
    preamble: "",
    briefMaxLines: 40,
    briefMaxSteps: 6,
    maxRuns: 2,
  });
});

test("codex configuration raises limits and preserves omitted defaults", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "qc-codex-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const codex = { briefMaxLines: 80, briefMaxSteps: 10, maxRuns: 4, disablePlugins: ["custom@plugins"], preamble: "Use the local rules." };
  writeFileSync(path.join(root, "qc.config.json"), JSON.stringify({ codex }));
  assert.deepEqual(load(root).codex, { ...defaults.codex, ...codex });
});

test("integrate defaults push every three merges", () => {
  const config = load(here);
  assert.equal(config.integrate.ciEvery, 3);
  assert.equal(config.integrate.push, true);
  assert.equal(config.integrate.branchPattern, "^[a-z]+/[0-9]+-integration$");
  assert.equal(config.integrate.review, true);
});

test("integrate configuration preserves omitted defaults", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "qc-integrate-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "qc.config.json"), JSON.stringify({ integrate: { ciEvery: 2 } }));
  assert.equal(load(root).integrate.ciEvery, 2);
  assert.equal(load(root).integrate.push, true);
  assert.equal(load(root).integrate.branchPattern, "^[a-z]+/[0-9]+-integration$");
  assert.equal(load(root).integrate.review, true);
  writeFileSync(path.join(root, "qc.config.json"), JSON.stringify({ integrate: { push: false } }));
  assert.equal(load(root).integrate.ciEvery, 3);
  assert.equal(load(root).integrate.push, false);
  assert.equal(load(root).integrate.branchPattern, "^[a-z]+/[0-9]+-integration$");
  assert.equal(load(root).integrate.review, true);
  writeFileSync(path.join(root, "qc.config.json"), JSON.stringify({ integrate: { branchPattern: "^release/", review: false } }));
  assert.equal(load(root).integrate.branchPattern, "^release/");
  assert.equal(load(root).integrate.review, false);
  assert.equal(load(root).integrate.ciEvery, 3);
  assert.equal(load(root).integrate.push, true);
});

test("integrate configuration rejects invalid types and cadences", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "qc-integrate-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const integrate of [null, [], false, "command"]) {
    writeFileSync(path.join(root, "qc.config.json"), JSON.stringify({ integrate }));
    assert.throws(() => load(root), { name: "TypeError", message: /integrate must be an object/ });
  }
  for (const [key, values] of Object.entries({
    ciEvery: [0, 1.5, "3"],
    push: ["yes"],
    branchPattern: [null, false, 1, [], {}, "["],
    review: [null, "true", 1, [], {}],
    base: [null, false, 5, [], {}, "", "  "],
  })) {
    for (const value of values) {
      writeFileSync(path.join(root, "qc.config.json"), JSON.stringify({ integrate: { [key]: value } }));
      assert.throws(() => load(root), { name: "TypeError", message: new RegExp(`integrate\\.${key}`) });
    }
  }
});

test("integrate.base accepts a non-empty branch string and stays unset by default", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "qc-integrate-base-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(load(root).integrate.base, undefined);
  writeFileSync(path.join(root, "qc.config.json"), JSON.stringify({ integrate: { base: "origin/release" } }));
  assert.equal(load(root).integrate.base, "origin/release");
});

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
