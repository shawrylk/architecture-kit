import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CORE_BEGIN, CORE_END } from "./setup-block.mjs";
import { runSetup } from "./setup.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "qc-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const kitDir = join(root, "kit");
  const cwd = join(root, "project");
  const settings = join(home, ".claude", "settings.json");
  const codex = join(home, ".codex", "config.toml");
  const claude = join(home, ".claude", "CLAUDE.md");
  const template = join(kitDir, "claude", "CLAUDE.core.md");
  for (const folder of [dirname(settings), dirname(codex), dirname(template), cwd]) mkdirSync(folder, { recursive: true });
  writeFileSync(settings, '{"theme":"dark"}');
  writeFileSync(codex, 'model = "x"');
  writeFileSync(template, "core rule\n");
  const logs = [];
  const options = {
    home, env: {}, kitDir, now: new Date("2026-01-02T03:04:05Z"), log: (line) => logs.push(line), cwd,
    run: () => ({ status: 0, stdout: "v22.0.0" }), exists: existsSync,
  };
  return { root, home, kitDir, cwd, settings, codex, claude, template, logs, options };
}

function snapshot(root) {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = join(entry.parentPath ?? entry.path, entry.name);
      return [relative(root, file), { text: readFileSync(file, "utf8"), mtime: statSync(file).mtimeMs }];
    }));
}

function budgets(f, value = { orchestrator: { compactAt: 200000 }, codex: { compactAt: 300000 } }, name = "custom.json") {
  const file = join(f.cwd, name);
  writeFileSync(file, JSON.stringify({ budgets: value }));
  return file;
}

function personalSkill(f) {
  const claudeDir = dirname(f.settings);
  const installPath = join(claudeDir, "plugins", "cache", "architecture");
  const folder = join(claudeDir, "skills", "registering-work");
  const pluginFolder = join(installPath, "skills", "registering-work");
  for (const dir of [folder, pluginFolder]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "# Register work\n");
  }
  writeFileSync(join(claudeDir, "plugins", "installed_plugins.json"), JSON.stringify({
    version: 2, plugins: { "architecture@architecture-kit": [{ scope: "user", installPath, version: "1.0.0" }] },
  }));
  writeFileSync(f.settings, JSON.stringify({ theme: "dark", enabledPlugins: { "architecture@architecture-kit": true } }));
  return folder;
}

test("sets up user files and logs each changed key", async (t) => {
  const f = fixture(t);
  const codexTime = statSync(f.codex).mtimeMs;
  assert.equal(await runSetup([], f.options), 0);
  assert.deepEqual(JSON.parse(readFileSync(f.settings, "utf8")), { theme: "dark", autoCompactEnabled: true });
  assert.equal(readFileSync(f.claude, "utf8"), `${CORE_BEGIN}\ncore rule\n${CORE_END}\n`);
  assert.equal(readFileSync(f.codex, "utf8"), 'model = "x"');
  assert.equal(statSync(f.codex).mtimeMs, codexTime);
  assert.ok(f.logs.includes(`Change ${f.settings}: autoCompactEnabled`));
  assert.ok(f.logs.some((line) => line.startsWith(`Change ${f.claude}: `)));
  assert.equal(f.logs.filter((line) => line.startsWith("Change ")).length, 2);
  const backup = readdirSync(dirname(f.settings)).find((name) => name.startsWith("settings.json.bak-"));
  assert.ok(backup);
  assert.equal(readFileSync(join(dirname(f.settings), backup), "utf8"), '{"theme":"dark"}');
  if (process.platform !== "win32") assert.equal(statSync(f.settings).mode & 0o777, 0o600);
});

test("a second run preserves every file and creates no backup", async (t) => {
  const f = fixture(t);
  assert.equal(await runSetup([], f.options), 0);
  for (const file of [f.settings, f.codex, f.claude]) utimesSync(file, 100, 100);
  const before = snapshot(f.root);
  f.logs.length = 0;
  assert.equal(await runSetup([], { ...f.options, now: new Date("2026-01-03T03:04:05Z") }), 0);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(f.logs.some((line) => line.startsWith("Change ")), false);
  assert.ok(f.logs.includes("Setup matches."));
});

test("preserves text outside the markers when the template changes", async (t) => {
  const f = fixture(t);
  assert.equal(await runSetup([], f.options), 0);
  writeFileSync(f.claude, `Personal rules\n${readFileSync(f.claude, "utf8")}More personal rules\n`);
  writeFileSync(f.template, "changed core rule\n");
  assert.equal(await runSetup([], f.options), 0);
  assert.equal(readFileSync(f.claude, "utf8"), `Personal rules\n${CORE_BEGIN}\nchanged core rule\n${CORE_END}\nMore personal rules\n`);
});

test("a dry run leaves all files and personal skills intact", async (t) => {
  const f = fixture(t);
  const folder = personalSkill(f);
  const before = snapshot(f.root);
  assert.equal(await runSetup(["--dry-run"], f.options), 0);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(existsSync(folder), true);
  assert.ok(f.logs.some((line) => line.startsWith(`Would change ${f.settings}: `)));
  assert.ok(f.logs.some((line) => line.startsWith(`Would change ${folder}: `)));
  assert.equal(f.logs.some((line) => line.startsWith("Change ")), false);
});

test("applies explicit budgets to each selected Claude model and Codex", async (t) => {
  const f = fixture(t);
  const config = budgets(f);
  assert.equal(await runSetup(["--config", config, "--model", "claude-opus-5-5", "--model", "claude-sonnet-5"], f.options), 0);
  const settings = JSON.parse(readFileSync(f.settings, "utf8"));
  assert.equal(settings.modelSettings["claude-opus-5-5"].autoCompactWindow, 200000);
  assert.equal(settings.modelSettings["claude-sonnet-5"].autoCompactWindow, 200000);
  assert.match(readFileSync(f.codex, "utf8"), /^model_auto_compact_token_limit = 300000$/m);
  assert.ok(f.logs.includes(`Change ${f.settings}: modelSettings.claude-opus-5-5.autoCompactWindow`));
  assert.ok(f.logs.includes(`Change ${f.codex}: model_auto_compact_token_limit`));
});

test("reads budgets from qc.config.json in the current directory", async (t) => {
  const f = fixture(t);
  budgets(f, undefined, "qc.config.json");
  assert.equal(await runSetup(["--model", "claude-opus-5-5"], f.options), 0);
  assert.equal(JSON.parse(readFileSync(f.settings, "utf8")).modelSettings["claude-opus-5-5"].autoCompactWindow, 200000);
  assert.match(readFileSync(f.codex, "utf8"), /^model_auto_compact_token_limit = 300000$/m);
});

test("lists a person step for budgets without a Claude model", async (t) => {
  const f = fixture(t);
  const config = budgets(f);
  assert.equal(await runSetup(["--config", config], f.options), 0);
  assert.equal(JSON.parse(readFileSync(f.settings, "utf8")).modelSettings, undefined);
  assert.ok(f.logs.some((line) => line.startsWith("  - ") && line.includes("--model")));
});

test("invalid settings leave every file untouched", async (t) => {
  const f = fixture(t);
  writeFileSync(f.settings, "{invalid");
  const before = snapshot(f.root);
  assert.equal(await runSetup([], f.options), 2);
  assert.deepEqual(snapshot(f.root), before);
  assert.match(f.logs.at(-1), /^qc setup: /);
});

test("invalid budgets leave every file untouched", async (t) => {
  const f = fixture(t);
  for (const value of [0, -1, 1.5, "200000"]) {
    const config = budgets(f, { codex: { compactAt: value } });
    const before = snapshot(f.root);
    assert.equal(await runSetup(["--config", config], f.options), 2);
    assert.deepEqual(snapshot(f.root), before);
    assert.match(f.logs.at(-1), /^qc setup: .*compactAt/);
  }
});

test("a missing explicit config warns on stderr and skips budgets", async (t) => {
  const f = fixture(t);
  const warnings = [];
  const config = join(f.cwd, "missing.json");
  const warning = t.mock.method(console, "error", (line) => warnings.push(line));
  assert.equal(await runSetup(["--config", config], f.options), 0);
  warning.mock.restore();
  assert.equal(readFileSync(f.codex, "utf8"), 'model = "x"');
  assert.ok(warnings.some((line) => line.includes(config) && /missing|not found/i.test(line)));
});

test("setup ignores unrelated personal skills, including a folder containing auth", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".aws"));
  writeFileSync(join(f.home, ".aws", "config"), "sso_session = work\n");
  const folders = ["authoring-docs", "my-own"].map((name) => join(dirname(f.settings), "skills", name));
  for (const folder of folders) {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SKILL.md"), "personal rule\n");
  }
  assert.equal(await runSetup([], { ...f.options, exists: () => true }), 0);
  assert.equal(f.logs.includes("Steps for a person:"), false);
  for (const folder of folders) assert.equal(readFileSync(join(folder, "SKILL.md"), "utf8"), "personal rule\n");
});

test("setup sets mode 0600 after writing an existing settings file", async (t) => {
  const f = fixture(t);
  const calls = [];
  const chmod = fs.chmodSync;
  const mocked = t.mock.method(fs, "chmodSync", (file, mode) => { calls.push({ file, mode }); chmod(file, mode); });
  syncBuiltinESMExports();
  try {
    assert.equal(await runSetup([], f.options), 0);
    assert.ok(calls.some(({ file, mode }) => file === f.settings && mode === 0o600));
    if (process.platform !== "win32") assert.equal(statSync(f.settings).mode & 0o777, 0o600);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test("removes a personal skill that matches its enabled plugin copy", async (t) => {
  const f = fixture(t);
  const folder = personalSkill(f);
  assert.equal(await runSetup([], f.options), 0);
  assert.equal(existsSync(folder), false);
  assert.ok(f.logs.some((line) => line.startsWith(`Change ${folder}: `)));
});

test("ends the log with each step for a person", async (t) => {
  const f = fixture(t);
  assert.equal(await runSetup([], f.options), 0);
  const heading = f.logs.indexOf("Steps for a person:");
  assert.ok(heading >= 0);
  assert.deepEqual(f.logs.slice(heading + 1), [
    "  - Run `codex login`",
    "  - Set up the AWS SSO profile: run `aws configure sso`",
  ]);
});

test("omits the person heading when all person steps are complete", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".aws"));
  writeFileSync(join(f.home, ".aws", "config"), "sso_session = work\n");
  assert.equal(await runSetup([], { ...f.options, exists: () => true }), 0);
  assert.equal(f.logs.includes("Steps for a person:"), false);
});

test("a late planning error leaves files and skills untouched", async (t) => {
  const f = fixture(t);
  personalSkill(f);
  const before = snapshot(f.root);
  assert.equal(await runSetup([], { ...f.options, run: () => { throw new Error("tool check failed"); } }), 2);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(f.logs.at(-1), "qc setup: tool check failed");
});

test("invalid markers fail before any write", async (t) => {
  const f = fixture(t);
  writeFileSync(f.claude, `${CORE_BEGIN}\n`);
  const before = snapshot(f.root);
  assert.equal(await runSetup([], f.options), 2);
  assert.deepEqual(snapshot(f.root), before);
});

test("rejects credential paths before any write", async (t) => {
  const f = fixture(t);
  const file = join(f.cwd, "auth.json");
  writeFileSync(file, "{}");
  const before = snapshot(f.root);
  assert.equal(await runSetup(["--config", file], f.options), 2);
  assert.deepEqual(snapshot(f.root), before);
  assert.match(f.logs.at(-1), /Refusing credential file/);
});

test("the CLI dispatches setup before loading the project config", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, "qc.config.json"), "{invalid");
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./qc.mjs", import.meta.url)), "setup", "--unknown"], {
    cwd: f.cwd, encoding: "utf8", windowsHide: true,
  });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /^qc setup: Unknown option '--unknown'/);
});
