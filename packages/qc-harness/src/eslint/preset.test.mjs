import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Linter } from "eslint";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
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
  // Against an all-on config: a policy rule ships off, and this asks whether a rule *can* reach
  // the preset, not which ones are in force by default.
  const blocks = preset({ config: config({ rules: Object.fromEntries(Object.keys(allRules).map((n) => [n, true])) }) });
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

/** One file through the whole preset, the way a consumer's `eslint .` sees it. */
function lint(code, filename, override = {}) {
  const blocks = preset({
    config: config(override),
    plugins: { tseslint },
    languageOptions: { parser: tsparser, ecmaVersion: 2023, sourceType: "module" },
  });
  return new Linter({ configType: "flat" }).verify(code, blocks, filename);
}

const RESOURCE = "backend/src/features/pins/resource.ts";
const MIGRATE = "backend/src/infrastructure/db/migrate.ts";
const byRule = (messages, ruleId) => messages.filter((m) => m.ruleId === ruleId);

test("a registry entry with names reaches qc/registry-literal, and one without stays out", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qc-preset-"));
  const holdpress = { value: 400, names: ["HOLD_\\w*MS"], readers: ["frontend/src/platform/gesture-thresholds.ts"] };
  writeFileSync(path.join(root, "quality-thresholds.json"), JSON.stringify({ gates: { holdpress, coverage: { value: 70 } } }));
  const setting = emitted(preset({ config: { ...config(), root } })).get("qc/registry-literal");
  assert.deepEqual(setting[1].entries, [{ key: "holdpress", names: holdpress.names, readers: holdpress.readers }]);
});

test("the ime config reaches qc/ime-safe-key", () => {
  const setting = emitted(preset({ config: config({ ime: { guards: ["isImeComposing"] } }) })).get("qc/ime-safe-key");
  assert.deepEqual(setting[1], { components: [], guards: ["isImeComposing"] });
});

test("the preset refuses an inline config comment in every file", () => {
  const block = preset({ config: config() }).find((b) => b.linterOptions);
  assert.ok(block, "no linterOptions block emitted");
  assert.equal(block.files, undefined, "linterOptions must reach every file");
  assert.deepEqual(block.linterOptions, { noInlineConfig: true, reportUnusedDisableDirectives: "error" });
});

test("an inline disable comment does not silence a rule", () => {
  const messages = lint("// eslint-disable-next-line qc/no-sql-raw\nawait db.execute(sql.raw(text));\n", RESOURCE);
  assert.equal(byRule(messages, "qc/no-sql-raw").length, 1, "the disable comment silenced the rule");
  const directive = messages.find((m) => m.ruleId === null && /noInlineConfig/.test(m.message));
  assert.ok(directive, "the ignored disable comment is not reported");
});

test("sql.raw fails, and sqlRaw.allow lets one reviewed file through", () => {
  const code = "await db.execute(sql.raw(ddl));\n";
  assert.equal(byRule(lint(code, RESOURCE), "qc/no-sql-raw")[0]?.severity, 2);
  assert.equal(byRule(lint(code, MIGRATE, { sqlRaw: { allow: [MIGRATE] } }), "qc/no-sql-raw").length, 0);
  assert.equal(byRule(lint(code, RESOURCE, { sqlRaw: { allow: [MIGRATE] } }), "qc/no-sql-raw").length, 1);
});

test("ts-ignore and ts-nocheck fail; ts-expect-error passes only with a description", () => {
  const banned = (code) => byRule(lint(code, RESOURCE), "@typescript-eslint/ban-ts-comment").length;
  assert.equal(banned("// @ts-ignore\nconst a = 1;\n"), 1);
  assert.equal(banned("// @ts-nocheck\nconst a = 1;\n"), 1);
  assert.equal(banned("// @ts-expect-error\nconst a = 1;\n"), 1);
  assert.equal(banned("// @ts-expect-error: the vendor type omits this field\nconst a = 1;\n"), 0);
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

