import test from "node:test";
import assert from "node:assert/strict";
import { defaults, merge } from "../config.mjs";
import { rules as allRules } from "./index.mjs";
import { preset } from "./preset.mjs";

const config = (override = {}) => ({ ...merge(defaults, override), root: process.cwd() });

/**
 * Every `qc/*` entry the preset turns on. The tooling block relaxes all of them and
 * comes last, so a plain last-write-wins read would see only `off`.
 */
function emitted(blocks) {
  const out = new Map();
  for (const block of blocks) {
    for (const [name, setting] of Object.entries(block.rules ?? {})) {
      if (!name.startsWith("qc/")) continue;
      if (setting === "off") continue;
      out.set(name, setting);
    }
  }
  return out;
}

test("every rule the config enables reaches the preset", () => {
  const blocks = preset({ config: config() });
  const on = emitted(blocks);
  for (const name of Object.keys(allRules)) {
    assert.ok(on.has(`qc/${name}`), `qc/${name} never reaches the lint config`);
  }
});

// The failure this guards: a switch flipped off that quietly stays on, or a rule
// renamed so its switch no longer reaches it.
test("a rule switched off in config is not emitted as an error", () => {
  const blocks = preset({ config: config({ rules: { "no-raw-fetch": false } }) });
  const settings = [];
  for (const block of blocks) {
    const setting = (block.rules ?? {})["qc/no-raw-fetch"];
    if (setting !== undefined) settings.push(setting);
  }
  assert.ok(!settings.includes("error"), "a disabled rule is still set to error");
  assert.ok(settings.every((s) => s === "off" || (Array.isArray(s) && s[0] !== "error")));
});

test("a rule's options come from the config, not from its own defaults", () => {
  const blocks = preset({ config: config({ apiClient: "net/http.ts" }) });
  const setting = emitted(blocks).get("qc/no-raw-fetch");
  assert.ok(Array.isArray(setting), "no-raw-fetch should carry options");
  assert.equal(setting[1].client, "net/http.ts");
});

test("the tooling block turns every qc rule off, so a gate can name what it bans", () => {
  const blocks = preset({ config: config() });
  const tooling = blocks.find((b) => JSON.stringify(b.files) === JSON.stringify(defaults.toolingFiles));
  assert.ok(tooling, "no tooling block emitted");
  for (const name of Object.keys(allRules)) {
    assert.equal(tooling.rules[`qc/${name}`], "off", `qc/${name} is not relaxed for tooling`);
  }
});

test("ignores come from the config", () => {
  const blocks = preset({ config: config({ ignores: ["**/generated/**"] }) });
  assert.deepEqual(blocks[0].ignores, ["**/generated/**"]);
});

test("the layer block is emitted only when a boundaries plugin is supplied", () => {
  const withoutPlugin = preset({ config: config() });
  assert.ok(!withoutPlugin.some((b) => b.rules?.["boundaries/element-types"]));
  const withPlugin = preset({ config: config(), plugins: { boundaries: {} } });
  assert.ok(withPlugin.some((b) => b.rules?.["boundaries/element-types"]));
});

test("a repository with no layers still gets the browser rules", () => {
  const blocks = preset({ config: config({ clientFiles: ["app/**/*.tsx"] }) });
  const client = blocks.find((b) => JSON.stringify(b.files) === JSON.stringify(["app/**/*.tsx"]));
  assert.ok(client, "no client block emitted");
  assert.ok(client.rules["qc/no-raw-fetch"]);
});

test("the frontendLayers block is emitted when configured and boundaries plugin is supplied", () => {
  const feConfig = config({
    frontendLayers: {
      include: ["frontend/src/**/*.{ts,tsx}"],
      elements: [{ type: "ui", pattern: "frontend/src/ui/**" }],
      allow: { ui: [] },
    },
  });
  const withoutPlugin = preset({ config: feConfig });
  assert.equal(withoutPlugin.filter((b) => b.rules?.["boundaries/element-types"]).length, 0);
  const withPlugin = preset({ config: feConfig, plugins: { boundaries: {} } });
  assert.ok(withPlugin.some((b) => b.rules?.["boundaries/element-types"]));
});

