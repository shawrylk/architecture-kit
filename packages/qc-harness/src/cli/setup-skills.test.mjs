import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dropPersonalSkills } from "./setup-skills.mjs";

const pluginKey = "architecture@architecture-kit";
const name = "registering-work";

function fixture(t) {
  const claudeDir = mkdtempSync(join(tmpdir(), "qc-setup-skills-"));
  t.after(() => rmSync(claudeDir, { recursive: true, force: true }));
  const installPath = join(claudeDir, "plugins", "cache", "architecture");
  const folder = join(claudeDir, "skills", name);
  const pluginFolder = join(installPath, "skills", name);
  mkdirSync(folder, { recursive: true });
  mkdirSync(pluginFolder, { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), "# Register work\n");
  writeFileSync(join(pluginFolder, "SKILL.md"), "# Register work\n");
  const registryPath = join(claudeDir, "plugins", "installed_plugins.json");
  const entries = [{ scope: "user", installPath, version: "1.0.0" }];
  writeFileSync(registryPath, JSON.stringify({ version: 2, plugins: { [pluginKey]: entries } }));
  return {
    claudeDir, folder, pluginFolder, registryPath, entries,
    options: {
      claudeDir,
      settingsText: JSON.stringify({ enabledPlugins: { [pluginKey]: true } }),
      names: [name],
    },
  };
}

function assertKept(f, reason, options = f.options) {
  assert.deepEqual(dropPersonalSkills(options), {
    removed: [], kept: [{ name, reason }],
  });
  assert.equal(existsSync(f.folder), true);
}

test("removes an identical personal skill after the plugin loads", (t) => {
  const f = fixture(t);
  assert.deepEqual(dropPersonalSkills(f.options), { removed: [f.folder], kept: [] });
  assert.equal(existsSync(f.folder), false);
  assert.equal(existsSync(join(f.pluginFolder, "SKILL.md")), true);
});

test("keeps a personal skill when the plugin is not enabled", (t) => {
  const f = fixture(t);
  rmSync(join(f.pluginFolder, "SKILL.md"));
  assertKept(f, "the plugin is not enabled", { ...f.options, settingsText: "{}" });
});

test("requires the enabled plugin setting to equal true", (t) => {
  const f = fixture(t);
  for (const enabled of [false, "true", 1]) {
    assertKept(f, "the plugin is not enabled", {
      ...f.options, settingsText: JSON.stringify({ enabledPlugins: { [pluginKey]: enabled } }),
    });
  }
});

test("treats invalid settings JSON as a disabled plugin", (t) => {
  const f = fixture(t);
  assertKept(f, "the plugin is not enabled", { ...f.options, settingsText: "not JSON" });
});

test("keeps a personal skill when the plugin copy is missing", (t) => {
  const f = fixture(t);
  rmSync(join(f.pluginFolder, "SKILL.md"));
  writeFileSync(join(f.folder, "notes.txt"), "Keep this file\n");
  assertKept(f, "the plugin copy is not installed");
});

test("treats a missing plugin registry as a missing installation", (t) => {
  const f = fixture(t);
  rmSync(f.registryPath);
  assertKept(f, "the plugin copy is not installed");
});

test("treats invalid plugin registry JSON as a missing installation", (t) => {
  const f = fixture(t);
  writeFileSync(f.registryPath, "not JSON");
  assertKept(f, "the plugin copy is not installed");
});

test("treats a plugin registry read error as a missing installation", (t) => {
  const f = fixture(t);
  rmSync(f.registryPath);
  mkdirSync(f.registryPath);
  assertKept(f, "the plugin copy is not installed");
});

test("keeps a personal skill that differs before checking its other files", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.folder, "SKILL.md"), "# Personal changes\n");
  writeFileSync(join(f.folder, "notes.txt"), "Keep this file\n");
  assertKept(f, "it differs from the plugin copy");
});

test("compares bytes that decode to the same text", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.folder, "SKILL.md"), Buffer.from([0x80]));
  writeFileSync(join(f.pluginFolder, "SKILL.md"), Buffer.from([0x81]));
  assertKept(f, "it differs from the plugin copy");
});

test("keeps an identical personal skill with another file", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.folder, "notes.txt"), "Keep this file\n");
  assertKept(f, "it holds files besides SKILL.md");
});

test("keeps an identical personal skill with another directory", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.folder, "references"));
  assertKept(f, "it holds files besides SKILL.md");
});

test("a dry run lists the personal folder and leaves it on disk", (t) => {
  const f = fixture(t);
  assert.deepEqual(dropPersonalSkills({ ...f.options, dryRun: true }), {
    removed: [f.folder], kept: [],
  });
  assert.equal(existsSync(join(f.folder, "SKILL.md")), true);
});

test("skips a name with no personal folder", (t) => {
  const f = fixture(t);
  assert.deepEqual(dropPersonalSkills({ ...f.options, names: ["absent-skill"] }), {
    removed: [], kept: [],
  });
});

test("skips a personal folder without SKILL.md", (t) => {
  const f = fixture(t);
  rmSync(join(f.folder, "SKILL.md"));
  assert.deepEqual(dropPersonalSkills(f.options), { removed: [], kept: [] });
  assert.equal(existsSync(f.folder), true);
});

test("finds a user installation after a project entry with a missing copy", (t) => {
  const f = fixture(t);
  writeFileSync(f.registryPath, JSON.stringify({
    version: 2,
    plugins: {
      [pluginKey]: [
        { scope: "project", installPath: join(f.claudeDir, "missing"), version: "1.0.0" },
        ...f.entries,
      ],
    },
  }));
  assert.deepEqual(dropPersonalSkills(f.options), { removed: [f.folder], kept: [] });
  assert.equal(existsSync(f.folder), false);
});

test("processes the supplied names in order", (t) => {
  const f = fixture(t);
  const second = "writing-plain-english";
  const secondFolder = join(f.claudeDir, "skills", second);
  const secondPluginFolder = join(f.entries[0].installPath, "skills", second);
  mkdirSync(secondFolder, { recursive: true });
  mkdirSync(secondPluginFolder, { recursive: true });
  writeFileSync(join(secondFolder, "SKILL.md"), "# Plain English\n");
  writeFileSync(join(secondPluginFolder, "SKILL.md"), "# Plain English\n");
  assert.deepEqual(dropPersonalSkills({ ...f.options, names: [second, "absent-skill", name] }), {
    removed: [secondFolder, f.folder], kept: [],
  });
  assert.equal(existsSync(secondFolder), false);
  assert.equal(existsSync(f.folder), false);
});
