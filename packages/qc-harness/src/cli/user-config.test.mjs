import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { packageUserConfig } from "./user-config-package.mjs";
import { mergeClaudeSettings, mergeCodexConfig, captureCodexConfig, configPaths, assertSafePath, kitUserConfigDir, runUserConfig } from "./user-config.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-user-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const kitDir = path.join(root, "kit");
  for (const dir of ["claude", "codex"]) mkdirSync(path.join(kitDir, dir), { recursive: true });
  writeFileSync(path.join(kitDir, "claude/settings.shared.json"), '{"model":"opus","enabledPlugins":{"kit@remote":true}}\n');
  writeFileSync(path.join(kitDir, "claude/statusline.js"), "console.log('status');\n");
  writeFileSync(path.join(kitDir, "codex/config.shared.toml"), 'model = "shared"\n[plugins."kit@remote"]\nenabled = true\n');
  const lines = [];
  return { root, kitDir, home: path.join(root, "home"), env: {}, log: (line) => lines.push(line), lines, now: new Date(2026, 0, 2, 3, 4, 5) };
}

test("JSON merges listed plugin and marketplace keys, preserving local keys and omitted shared keys", () => {
  const local = { model: "old", effortLevel: "high", local: 7, enabledPlugins: { local: true, kit: false }, extraKnownMarketplaces: { local: {} } };
  const shared = { model: "opus", local: 9, enabledPlugins: { kit: true }, extraKnownMarketplaces: { remote: { source: { source: "github", repo: "a/b" } } } };
  const result = mergeClaudeSettings(JSON.stringify(local), JSON.stringify(shared));
  assert.deepEqual(JSON.parse(result.text), { ...local, model: "opus", enabledPlugins: { local: true, kit: true }, extraKnownMarketplaces: { ...local.extraKnownMarketplaces, ...shared.extraKnownMarketplaces } });
  assert.deepEqual(result.changed, ["model", "enabledPlugins.kit", "extraKnownMarketplaces.remote"]);
  assert.deepEqual(mergeClaudeSettings(result.text, JSON.stringify(shared)).changed, []);
});

test("TOML merges top-level keys and plugin fields while preserving comments and unrelated lines", () => {
  const local = '# keep\r\nmodel = "old" # model comment\r\nnotify = ["local"]\r\n\r\n[desktop]\r\nmodel = "desktop"\r\n[plugins."kit@remote"] # plugin comment\r\nenabled = false # enabled comment\r\nlocal = 42\r\n[plugins."local@private"]\r\nenabled = true\r\n';
  const shared = 'model = "new"\nservice_tier = "default"\nnotify = ["wrong"]\n[desktop]\nmodel = "wrong"\n[plugins."kit@remote"]\nenabled = true\n[plugins."new@remote"]\nenabled = false\n';
  const result = mergeCodexConfig(local, shared);
  assert.ok(result.text.includes('model = "new" # model comment\r\n'));
  assert.ok(result.text.includes('notify = ["local"]\r\n'));
  assert.ok(result.text.includes('[desktop]\r\nmodel = "desktop"\r\n'));
  assert.ok(result.text.includes('[plugins."kit@remote"] # plugin comment\r\nenabled = true # enabled comment\r\nlocal = 42'));
  assert.ok(result.text.includes('[plugins."local@private"]\r\nenabled = true'));
  assert.ok(result.text.includes('service_tier = "default"\r\n'));
  assert.ok(result.text.includes('[plugins."new@remote"]\r\nenabled = false'));
  assert.deepEqual(mergeCodexConfig(result.text, shared).changed, []);
});

test("TOML preserves multiline local values and ignores fake headers inside strings", () => {
  const local = 'notify = [\n "keep",\n]\nmodel = "old"\n[desktop]\ntext = """\n[plugins."fake@local"]\nenabled = false\n"""\n';
  const result = mergeCodexConfig(local, 'model = "new"\n');
  assert.equal(result.text, local.replace('model = "old"', 'model = "new"'));
});

test("TOML consumes multiline values of bare and quoted dotted keys", () => {
  for (const key of ["x.y", '"x" . \'y\'', '\'x\' . "y" . z']) {
    for (const quote of ['"""', "'''"]) {
      const local = `${key} = ${quote}\nmodel = "inner"\n[plugins."fake@r"]\nenabled = false\n${quote}\n`;
      assert.equal(mergeCodexConfig(local, 'model = "new"\n').text, `${local}model = "new"\n`);
      assert.equal(captureCodexConfig(local), "");
    }
  }
});

test("TOML handles a final value without a newline and compares string values", () => {
  assert.equal(mergeCodexConfig('model = "old"', 'model = "new"').text, 'model = "new"');
  const local = "model = 'same' # keep quotes\n";
  assert.equal(mergeCodexConfig(local, 'model = "same"\n').text, local);
});

test("a shared plugin field keeps local fields and adds the missing enabled field", () => {
  const local = '[plugins."kit@remote"]\nlocal = true';
  const merged = mergeCodexConfig(local, '[plugins."kit@remote"]\nenabled = true\n');
  assert.equal(merged.text, `${local}\nenabled = true\n`);
});

test("TOML fills existing plugin sections before appending new tables", () => {
  const shared = '[plugins."A@r"]\nenabled = true\n[plugins."B@r"]\nenabled = true\n';
  for (const eol of ["\n", "\r\n"]) {
    for (const suffix of ["", eol]) {
      const local = `# keep${eol}[plugins."B@r"]${suffix}`;
      const expected = '# keep\n[plugins."B@r"]\nenabled = true\n\n[plugins."A@r"]\nenabled = true\n'.replaceAll("\n", eol);
      assert.equal(mergeCodexConfig(local, shared).text, expected);
    }
  }
});

function parseTomlFile(file) {
  const result = spawnSync("python", ["-c", "import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], 'rb'))))", file], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const [form, local] of [
  ["top-level inline", 'plugins = { "kit@remote" = { enabled = false, local = 42 } }\n'],
  ["dotted inline", 'plugins."kit@remote" = { enabled = false, local = 42 }\n'],
  ["dotted field", 'plugins."kit@remote".enabled = false\nplugins."kit@remote".local = 42\n'],
  ["plugins table", '[plugins]\n"kit@remote" = { enabled = false, local = 42 }\n'],
]) {
  test(`apply merges the ${form} plugin form into valid TOML`, async (t) => {
    const f = fixture(t);
    writeFileSync(path.join(f.kitDir, "codex/config.shared.toml"), '[plugins."kit@remote"]\nenabled = true\n');
    const file = configPaths(f.home, f.env).codex;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, local);
    assert.equal(await runUserConfig(["apply"], f), 0, f.lines.join("\n"));
    assert.deepEqual(parseTomlFile(file).plugins["kit@remote"], { enabled: true, local: 42 });
    assert.equal(readFileSync(file, "utf8"), local.replace("false", "true"));
    assert.equal(await runUserConfig(["apply"], f), 0);
  });
}

test("plugin forms add missing fields and plugins without duplicate tables", async (t) => {
  for (const local of [
    '"plugins" = { "kit@remote" = { local = { x = 42 } } }\n',
    "'plugins'.'kit@remote' = { local = { x = 42 } }\n",
    'plugins."kit@remote".local = { x = 42 }\n',
    '[plugins]\n"kit@remote" = { local = { x = 42 } }\n',
  ]) {
    const f = fixture(t);
    writeFileSync(path.join(f.kitDir, "codex/config.shared.toml"), '[plugins."kit@remote"]\nenabled = true\n[plugins."new@remote"]\nenabled = false\n');
    const file = configPaths(f.home, f.env).codex;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, local);
    assert.equal(await runUserConfig(["apply"], f), 0, f.lines.join("\n"));
    assert.deepEqual(parseTomlFile(file).plugins, {
      "kit@remote": { local: { x: 42 }, enabled: true }, "new@remote": { enabled: false },
    });
    assert.deepEqual(mergeCodexConfig(readFileSync(file, "utf8"), readFileSync(path.join(f.kitDir, "codex/config.shared.toml"), "utf8")).changed, []);
  }
});

test("incompatible plugin values name the form and line before any write", async (t) => {
  for (const [form, local] of [
    ["top-level inline plugins table", '# keep\nplugins = false\n'],
    ["dotted inline plugin table", '# keep\nplugins."kit@remote" = false\n'],
    ["[plugins] table", '# keep\n[plugins]\n"kit@remote" = false\n'],
  ]) {
    const f = fixture(t);
    const file = configPaths(f.home, f.env).codex;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, local);
    assert.equal(await runUserConfig(["apply"], f), 2);
    assert.ok(f.lines.at(-1).includes(form), f.lines.join("\n"));
    assert.match(f.lines.at(-1), /line [23]/);
    assert.equal(readFileSync(file, "utf8"), local);
    parseTomlFile(file);
    assert.equal(readdirSync(path.dirname(file)).length, 1);
  }
});

test("an empty inline plugins table accepts several plugins as valid TOML", async (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.kitDir, "codex/config.shared.toml"), '[plugins."kit@remote"]\nenabled = true\n[plugins."new@remote"]\nenabled = false\n');
  const file = configPaths(f.home, f.env).codex;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "plugins = {}\n");
  assert.equal(await runUserConfig(["apply"], f), 0);
  assert.deepEqual(parseTomlFile(file).plugins, { "kit@remote": { enabled: true }, "new@remote": { enabled: false } });
});

test("credential names match whole words and allow author", async (t) => {
  const f = fixture(t);
  f.env.CODEX_HOME = path.join(f.root, "author");
  assert.doesNotThrow(() => assertSafePath("author.toml"));
  assert.throws(() => assertSafePath("auth_token.toml"), /credential/i);
  assert.equal(await runUserConfig(["apply"], f), 0);
  assert.equal(parseTomlFile(configPaths(f.home, f.env).codex).model, "shared");
});

test("malformed shared configuration fails before any target changes", async (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.kitDir, "codex/config.shared.toml"), 'model = "unterminated');
  assert.equal(await runUserConfig(["apply"], f), 2);
  assert.deepEqual(readdirSync(f.root), ["kit"]);
});

test("backup collisions fail without overwriting the backup or original file", async (t) => {
  const f = fixture(t);
  const paths = configPaths(f.home, f.env);
  mkdirSync(path.dirname(paths.claude), { recursive: true });
  writeFileSync(paths.claude, '{"model":"local"}');
  const backup = `${paths.claude}.bak-20260102-030405`;
  writeFileSync(backup, "keep backup");
  assert.equal(await runUserConfig(["apply"], f), 2);
  assert.equal(readFileSync(backup, "utf8"), "keep backup");
  assert.equal(readFileSync(paths.claude, "utf8"), '{"model":"local"}');
});

test("a later backup collision stops all target writes", async (t) => {
  const f = fixture(t);
  const paths = configPaths(f.home, f.env);
  mkdirSync(path.dirname(paths.claude), { recursive: true });
  mkdirSync(path.dirname(paths.codex), { recursive: true });
  const originals = new Map([
    [paths.claude, '{"model":"local"}\n'],
    [paths.codex, 'model = "local"\n'],
    [paths.statusline, "local status\n"],
  ]);
  for (const [file, text] of originals) writeFileSync(file, text);
  const backup = `${paths.codex}.bak-20260102-030405`;
  writeFileSync(backup, "keep backup");
  assert.equal(await runUserConfig(["apply"], f), 2);
  assert.match(f.lines.at(-1), /EEXIST/);
  for (const [file, text] of originals) assert.equal(readFileSync(file, "utf8"), text);
  assert.equal(readFileSync(backup, "utf8"), "keep backup");
});

test("capture excludes local marketplaces, their plugins, notify, and desktop settings", () => {
  const source = 'model = "shared"\nnotify = ["private"]\n[marketplaces.local]\nsource_type = "local"\nsource = "C:/private"\n[marketplaces.remote]\nsource_type = "git"\nsource = "https://example.com/kit.git"\n[plugins."keep@remote"]\nenabled = true\n[plugins."skip@local"]\nenabled = true\n[desktop]\nsecret = "private"\n';
  assert.equal(captureCodexConfig(source), 'model = "shared"\n\n[plugins."keep@remote"]\nenabled = true\n');
});

test("apply backs up changed files, lists keys, and leaves matching files untouched", async (t) => {
  const f = fixture(t);
  const paths = configPaths(f.home, f.env);
  mkdirSync(path.dirname(paths.claude), { recursive: true });
  writeFileSync(paths.claude, '{"model":"local","outside":true}\n');
  assert.equal(await runUserConfig(["apply"], f), 0);
  assert.equal(readFileSync(`${paths.claude}.bak-20260102-030405`, "utf8"), '{"model":"local","outside":true}\n');
  assert.equal(JSON.parse(readFileSync(paths.claude)).outside, true);
  assert.ok(f.lines.some((line) => line.includes("model")));
  const before = readdirSync(path.dirname(paths.claude));
  assert.equal(await runUserConfig(["apply"], f), 0);
  assert.deepEqual(readdirSync(path.dirname(paths.claude)), before);
  assert.equal(await runUserConfig(["check"], f), 0);
});

test("check returns one for drift and dry-run changes no files", async (t) => {
  const f = fixture(t);
  assert.equal(await runUserConfig(["check"], f), 1);
  assert.equal(await runUserConfig(["apply", "--dry-run"], f), 0);
  assert.deepEqual(readdirSync(f.root).sort(), ["kit"]);
  assert.ok(f.lines.some((line) => line.includes("statusline.js")));
});

test("capture writes shared data only and supports dry-run", async (t) => {
  const f = fixture(t);
  const paths = configPaths(f.home, f.env);
  mkdirSync(path.dirname(paths.claude), { recursive: true });
  mkdirSync(path.dirname(paths.codex), { recursive: true });
  writeFileSync(paths.claude, '{"model":"local","outside":"private","env":{"TOKEN":"private","CLAUDE_CODE_DISABLE_MOUSE":"1"}}');
  writeFileSync(paths.codex, 'model = "local"\nnotify = ["private"]\n');
  writeFileSync(paths.statusline, "status source\n");
  assert.equal(await runUserConfig(["capture", "--dry-run"], f), 0);
  assert.equal(JSON.parse(readFileSync(path.join(f.kitDir, "claude/settings.shared.json"))).model, "opus");
  assert.equal(await runUserConfig(["capture"], f), 0);
  const captured = JSON.parse(readFileSync(path.join(f.kitDir, "claude/settings.shared.json")));
  assert.deepEqual(captured, { model: "local", env: { CLAUDE_CODE_DISABLE_MOUSE: "1" } });
  assert.equal(readFileSync(path.join(f.kitDir, "claude/statusline.js"), "utf8"), "status source\n");
});

for (const filename of [".claude.json", ".credentials.json", "auth.json", "api-token.json", "service-secret.toml", "my-credential.txt", "oauth-cache.json"]) {
  test(`refuses credential filename ${filename} on Windows and POSIX paths`, async (t) => {
    const f = fixture(t);
    for (const name of [`/home/a/${filename}`, `C:\\Users\\a\\${filename.toUpperCase()}`]) {
      assert.throws(() => assertSafePath(name), /credential/i);
      for (const verb of ["apply", "capture"]) {
        f.lines.length = 0;
        assert.equal(await runUserConfig([verb, "--dry-run", "--codex-dir", name], f), 2);
        assert.match(f.lines.at(-1), /Refusing credential file:/);
      }
    }
    assert.deepEqual(readdirSync(f.root), ["kit"]);
  });
}

test("refuses credential symlinks before changing another file", async (t) => {
  const f = fixture(t);
  const paths = configPaths(f.home, f.env);
  mkdirSync(path.dirname(paths.codex), { recursive: true });
  const secret = path.join(f.root, "auth.json");
  writeFileSync(secret, "credential sentinel");
  try { symlinkSync(secret, paths.codex); } catch (error) {
    if (error.code === "EPERM") return t.skip("Windows requires symlink privileges");
    throw error;
  }
  assert.equal(await runUserConfig(["apply"], f), 2);
  assert.deepEqual(readdirSync(f.home), [".codex"]);
  assert.equal(readFileSync(secret, "utf8"), "credential sentinel");
});

test("home paths use the host path style and respect config environment overrides", () => {
  assert.equal(configPaths("/home/person", {}).claude, "/home/person/.claude/settings.json");
  assert.equal(configPaths("C:\\Users\\person", {}).codex, "C:\\Users\\person\\.codex\\config.toml");
  assert.equal(configPaths("/home/person", { CLAUDE_CONFIG_DIR: "/config/claude", CODEX_HOME: "/config/codex" }).statusline, "/config/claude/statusline.js");
});

test("CLI dispatch runs outside a repository and returns usage errors", () => {
  const cli = fileURLToPath(new URL("./qc.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "user-config", "invalid"], { cwd: os.tmpdir(), encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /user-config/);
});

test("CLI check returns drift, matching, and error exit codes", (t) => {
  const f = fixture(t);
  const paths = configPaths(f.home, f.env);
  const cli = fileURLToPath(new URL("./qc.mjs", import.meta.url));
  const args = [cli, "user-config", "check", "--kit-dir", f.kitDir, "--claude-dir", path.dirname(paths.claude), "--codex-dir", path.dirname(paths.codex)];
  const run = () => spawnSync(process.execPath, args, { cwd: os.tmpdir(), encoding: "utf8" });
  assert.equal(run().status, 1);
  mkdirSync(path.dirname(paths.claude), { recursive: true });
  mkdirSync(path.dirname(paths.codex), { recursive: true });
  writeFileSync(paths.claude, readFileSync(path.join(f.kitDir, "claude/settings.shared.json")));
  writeFileSync(paths.codex, readFileSync(path.join(f.kitDir, "codex/config.shared.toml")));
  writeFileSync(paths.statusline, readFileSync(path.join(f.kitDir, "claude/statusline.js")));
  assert.equal(run().status, 0);
  writeFileSync(paths.claude, "invalid JSON");
  assert.equal(run().status, 2);
});

test("package staging includes all three shared files and resolves them outside the checkout", async (t) => {
  const f = fixture(t);
  const target = path.join(f.root, "node_modules/architecture-harness/user-config");
  packageUserConfig(f.kitDir, target);
  assert.equal(readFileSync(path.join(target, "claude/statusline.js"), "utf8"), "console.log('status');\n");
  assert.equal(readFileSync(path.join(target, "codex/config.shared.toml"), "utf8"), readFileSync(path.join(f.kitDir, "codex/config.shared.toml"), "utf8"));
  assert.equal(readFileSync(path.join(target, "claude/settings.shared.json"), "utf8"), readFileSync(path.join(f.kitDir, "claude/settings.shared.json"), "utf8"));
  mkdirSync(path.join(f.root, "user-config"));
  const moduleUrl = pathToFileURL(path.join(f.root, "node_modules/architecture-harness/src/cli/user-config.mjs"));
  assert.equal(kitUserConfigDir(moduleUrl), `${target}${path.sep}`);
  mkdirSync(path.join(f.root, ".claude-plugin"));
  writeFileSync(path.join(f.root, ".claude-plugin/plugin.json"), "{}");
  assert.equal(kitUserConfigDir(moduleUrl), `${path.join(f.root, "user-config")}${path.sep}`);
});

for (const home of ["/home/person", "C:\\Users\\person"]) {
  test(`seeded status line keeps its three rows with home ${home}`, () => {
    const source = readFileSync(new URL("../../../../user-config/claude/statusline.js", import.meta.url), "utf8");
    let input;
    let output = "";
    const fakeFs = { readFileSync: () => { throw new Error("No cache or account"); }, readdirSync: () => [], writeFileSync: () => {} };
    const fakeProcess = {
      env: { CLAUDE_CONFIG_DIR: `${home}/custom-claude` }, cwd: () => `${home}/project`,
      stdin: { on: (event, fn) => { if (event === "data") input = fn; return { on: (_event, end) => { input(JSON.stringify({ model: { display_name: "Test model" }, context_window: { used_percentage: 20, context_window_size: 1000000 }, rate_limits: { five_hour: { used_percentage: 10, resets_at: 9999999999 }, seven_day: { used_percentage: 20, resets_at: 9999999999 } } })); end(); } }; } },
      stdout: { write: (value) => { output += value; } },
    };
    vm.runInNewContext(source, { process: fakeProcess, Buffer, require: (name) => {
      if (name === "fs" || name === "node:fs") return fakeFs;
      if (name === "os" || name === "node:os") return { homedir: () => home };
      if (name === "path" || name === "node:path") return home.startsWith("C:") ? path.win32 : path.posix;
      if (name === "child_process" || name === "node:child_process") return { execFileSync: () => { throw new Error("No repository"); } };
      throw new Error(`Unexpected module ${name}`);
    } });
    assert.equal(output.split("\n").length, 3);
    assert.match(output, /~\/project/);
    assert.match(output, /Test model/);
    assert.match(output, /custom-claude/);
    assert.match(output, /weekly 20%/);
  });
}
