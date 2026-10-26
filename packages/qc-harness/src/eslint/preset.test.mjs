import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
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

test("the idempotency key format reaches the rule", () => {
  const set = emitted(preset({ config: config({ idempotency: { format: "uuid" } }) })).get("qc/durable-idempotency-key");
  assert.equal(set[1].format, "uuid");
  const off = emitted(preset({ config: config() })).get("qc/durable-idempotency-key");
  assert.equal(off[1].format, null);
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

test("ignores come from the config, and a repository list of its own still skips the worktree folder", () => {
  const blocks = preset({ config: config({ ignores: ["**/generated/**"] }) });
  assert.deepEqual(blocks[0].ignores, ["**/generated/**", ".worktree/**"]);
  const moved = preset({ config: config({ ignores: [], worktree: { dir: "trees/" } }) });
  assert.deepEqual(moved[0].ignores, ["trees/**"]);
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

const LIFETIMES = {
  lifetimes: {
    offlinegrace: { value: 7, unit: "days", readers: ["frontend/src/platform/auth/device-session.ts"], match: ["offline grace"] },
    clockdrift: { value: 5, unit: "minutes", match: ["clock drift"] },
  },
};

test("a listed registry reaches qc/registry-literal: an entry that names readers restricts its number", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qc-preset-"));
  writeFileSync(path.join(root, "quality-thresholds.json"), JSON.stringify({ gates: {} }));
  writeFileSync(path.join(root, "session-lifetimes.json"), JSON.stringify(LIFETIMES));
  const registries = [{ path: "session-lifetimes.json", key: "lifetimes", prefix: "ttl" }];
  const setting = emitted(preset({ config: { ...config({ registryLiteral: { registries } }), root } })).get("qc/registry-literal");
  assert.deepEqual(setting[1].values, [
    { key: "offlinegrace", registry: "session-lifetimes.json", value: 7, readers: ["frontend/src/platform/auth/device-session.ts"] },
  ]);
});

test("a session lifetime in code fails outside its reader, through the whole preset", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qc-preset-"));
  writeFileSync(path.join(root, "quality-thresholds.json"), JSON.stringify({ gates: {} }));
  writeFileSync(path.join(root, "session-lifetimes.json"), JSON.stringify(LIFETIMES));
  const registries = [{ path: "session-lifetimes.json", key: "lifetimes", prefix: "ttl" }];
  const run = (filename) => {
    const blocks = preset({
      config: { ...config({ registryLiteral: { registries } }), root },
      plugins: { tseslint },
      languageOptions: { parser: tsparser, ecmaVersion: 2023, sourceType: "module" },
    });
    return byRule(new Linter({ configType: "flat" }).verify("export const graceDays = 7;\nexport const drift = 5;\nexport type Days = 7;\n", blocks, filename), "qc/registry-literal");
  };
  assert.equal(run("frontend/src/features/login/form.ts").length, 1);
  assert.equal(run("frontend/src/platform/auth/device-session.ts").length, 0);
});

test("the ime config reaches qc/ime-safe-key", () => {
  const setting = emitted(preset({ config: config({ ime: { guards: ["isImeComposing"] }, rules: { "ime-safe-key": true } }) })).get("qc/ime-safe-key");
  assert.deepEqual(setting[1], { components: [], guards: ["isImeComposing"] });
});

test("mutation-control-pending is off by default and reaches the client files with its options when on", () => {
  const client = (rules) => {
    const blocks = preset({ config: config({ clientFiles: ["frontend/src/**/*.tsx"], rules }) });
    return emitted(blocks.filter((block) => block.files?.includes("frontend/src/**/*.tsx"))).get("qc/mutation-control-pending");
  };
  assert.equal(client({}), undefined);
  const setting = client({ "mutation-control-pending": true });
  assert.deepEqual(setting[1], { button: "Button", prop: "loading", handlers: ["onClick", "onSelect", "onConfirm"] });
});

test("the mutationControl config reaches qc/mutation-control-pending", () => {
  const blocks = preset({
    config: config({ clientFiles: ["src/**/*.tsx"], rules: { "mutation-control-pending": true }, mutationControl: { button: "Action", prop: "busy" } }),
  });
  const setting = emitted(blocks).get("qc/mutation-control-pending");
  assert.deepEqual(setting[1], { button: "Action", prop: "busy", handlers: ["onClick", "onSelect", "onConfirm"] });
});

test("the UI rules reach only clientFiles and use the configured primitive folders and class callees", () => {
  const names = ["one-component-per-file", "raw-element-in-primitive", "no-arbitrary-class-value", "no-literal-color", "no-static-inline-style"];
  const clientFiles = ["app/**/*.tsx"];
  const blocks = preset({
    config: config({ clientFiles, rules: Object.fromEntries(names.map((name) => [name, true])), ui: { layers: { primitive: ["app/primitives", "app/controls"] }, classCallees: ["classes", "cva"] } }),
    languageOptions: { parser: tsparser },
  });
  const client = blocks.find((block) => block.files === clientFiles);
  for (const name of names) {
    assert.ok(client.rules[`qc/${name}`]);
    assert.equal(emitted(preset({ config: config() })).has(`qc/${name}`), false);
    assert.equal(emitted(blocks.filter((block) => block !== client)).has(`qc/${name}`), false);
  }
  assert.deepEqual(client.rules["qc/raw-element-in-primitive"][1], { primitive: ["app/primitives", "app/controls"] });
  for (const name of names.slice(2, 4)) assert.deepEqual(client.rules[`qc/${name}`][1], { classCallees: ["classes", "cva"] });
  const linter = new Linter({ configType: "flat" });
  const messages = (code, filename, name) => byRule(linter.verify(code, blocks, filename), `qc/${name}`);
  const pair = "const First = () => <div />; const Second = () => <span />;";
  assert.equal(messages(pair, "app/view.tsx", names[0]).length, 2);
  assert.equal(messages(pair, "elsewhere/view.tsx", names[0]).length, 0);
  assert.equal(messages("<input />;", "app/view.tsx", names[1]).length, 1);
  assert.equal(messages("<input />;", "app/controls/input.tsx", names[1]).length, 0);
  assert.equal(messages('classes("text-[11px]");', "app/view.tsx", names[2]).length, 1);
  assert.equal(messages('classes("bg-[#abc]");', "app/view.tsx", names[3]).length, 1);
  for (const name of names.slice(2, 4)) {
    assert.equal(messages('cn("bg-[#abc]");', "app/view.tsx", name).length, 0);
    assert.equal(messages('classes("bg-[#abc]");', "elsewhere/view.tsx", name).length, 0);
    assert.equal(messages('cva("p-2", { variants: { tone: { custom: "bg-[#abc]" } } });', "app/view.tsx", name).length, 1);
  }
  assert.equal(messages('<div style={{ width: 12 }} />;', "app/view.tsx", names[4]).length, 1);
  assert.equal(messages('<div style={{ width: size }} />;', "app/view.tsx", names[4]).length, 0);
  assert.equal(messages('<div style={{ width: 12 }} />;', "elsewhere/view.tsx", names[4]).length, 0);
});

for (const source of ["hand-written", "ESLint-generated"]) {
  test(`qc lint applies the ${source} UI baseline and fails on a stale entry`, () => {
    const root = mkdtempSync(path.join(tmpdir(), "qc-ui-suppressions-"));
    const require = createRequire(import.meta.url);
    const cli = fileURLToPath(new URL("../cli/qc.mjs", import.meta.url));
    const parser = pathToFileURL(require.resolve("@typescript-eslint/parser")).href;
    const presetUrl = new URL("./preset.mjs", import.meta.url).href;
    const configUrl = new URL("../config.mjs", import.meta.url).href;
    const switches = Object.fromEntries(Object.keys(allRules).map((name) => [name, name === "no-static-inline-style"]));
    const run = (...args) => {
      const result = spawnSync(process.execPath, [cli, "lint", ...args], { cwd: root, encoding: "utf8", timeout: 30_000 });
      assert.ifError(result.error);
      return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
    };
    try {
      const init = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
      assert.equal(init.status, 0, init.stderr);
      mkdirSync(path.join(root, "node_modules"));
      symlinkSync(path.dirname(require.resolve("eslint/package.json")), path.join(root, "node_modules", "eslint"), "junction");
      writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
      writeFileSync(path.join(root, "qc.config.json"), JSON.stringify({ featureRoots: [] }));
      writeFileSync(path.join(root, "eslint.config.mjs"), `
        import parser from ${JSON.stringify(parser)};
        import { preset } from ${JSON.stringify(presetUrl)};
        import { defaults, merge } from ${JSON.stringify(configUrl)};
        export default preset({
          config: { ...merge(defaults, ${JSON.stringify({ clientFiles: ["**/*.tsx"], rules: switches })}), root: process.cwd() },
          languageOptions: { parser },
        });
      `);
      const relativeFixture = source === "ESLint-generated" ? "src/view.tsx" : "view.tsx";
      const fixture = path.join(root, relativeFixture);
      mkdirSync(path.dirname(fixture), { recursive: true });
      writeFileSync(fixture, '<div style={{ width: 12 }} />;\n');
      const unsuppressed = run();
      assert.equal(unsuppressed.status, 1, unsuppressed.output);
      assert.match(unsuppressed.output, /qc\/no-static-inline-style/);
      if (source === "ESLint-generated") {
        const eslint = path.join(path.dirname(require.resolve("eslint/package.json")), "bin", "eslint.js");
        const result = spawnSync(process.execPath, [eslint, relativeFixture, "--suppress-rule", "qc/no-static-inline-style"], { cwd: root, encoding: "utf8", timeout: 30_000 });
        assert.ifError(result.error);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      } else {
        writeFileSync(path.join(root, "eslint-suppressions.json"), JSON.stringify({ "view.tsx": { "qc/no-static-inline-style": { count: 1 } } }));
      }
      const generated = run();
      assert.equal(generated.status, 0, generated.output);
      const baseline = JSON.parse(readFileSync(path.join(root, "eslint-suppressions.json"), "utf8"));
      assert.equal(baseline[relativeFixture]["qc/no-static-inline-style"].count, 1);
      const existing = run();
      assert.equal(existing.status, 0, existing.output);
      writeFileSync(fixture, '<><div style={{ width: 12 }} /><div style={{ height: 8 }} /></>;\n');
      const increased = run();
      assert.equal(increased.status, 1, increased.output);
      assert.match(increased.output, /qc\/no-static-inline-style/);
      writeFileSync(fixture, '<div style={{ width: size }} />;\n');
      const stale = run();
      assert.equal(stale.status, 2, stale.output);
      assert.match(stale.output, /suppressions left that do not occur anymore/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("the preset reports an unused disable comment in every file", () => {
  const block = preset({ config: config() }).find((b) => b.linterOptions);
  assert.ok(block, "no linterOptions block emitted");
  assert.equal(block.files, undefined, "linterOptions must reach every file");
  assert.deepEqual(block.linterOptions, { reportUnusedDisableDirectives: "error" });
});

test("a disable comment silences its rule, and one that silences nothing is an error", () => {
  const used = lint("// eslint-disable-next-line qc/no-sql-raw\nawait db.execute(sql.raw(text));\n", RESOURCE);
  assert.equal(byRule(used, "qc/no-sql-raw").length, 0);
  const unused = lint("// eslint-disable-next-line qc/no-sql-raw\nconst a = 1;\n", RESOURCE);
  assert.ok(unused.some((m) => m.ruleId === null && m.severity === 2 && /Unused eslint-disable/.test(m.message)), JSON.stringify(unused));
});

test("a comment-style rule warns, and a rule of the reference stack is off until a repository turns it on", () => {
  const rules = emitted(preset({ config: config() }));
  for (const name of ["no-comment-paragraph", "no-number-in-comment", "no-supersession-trail"]) assert.equal([rules.get(`qc/${name}`)].flat()[0], "warn", name);
  for (const name of ["no-offset-pagination", "no-status-literal", "no-promise-then", "signal-last-param", "ime-safe-key"]) assert.equal(rules.get(`qc/${name}`), undefined, name);
  assert.equal([emitted(preset({ config: config({ rules: { "no-offset-pagination": true } }) })).get("qc/no-offset-pagination")].flat()[0], "error");
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

