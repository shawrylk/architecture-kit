import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const pluginKey = "architecture@architecture-kit";

/** Fragment: read whether Claude enables the architecture plugin. */
function pluginEnabled(settingsText) {
  try {
    return JSON.parse(settingsText)?.enabledPlugins?.[pluginKey] === true;
  } catch {
    return false;
  }
}

/** Fragment: read installation paths from the optional plugin registry. */
function pluginInstallPaths(claudeDir) {
  try {
    const registry = JSON.parse(readFileSync(join(claudeDir, "plugins", "installed_plugins.json"), "utf8"));
    const entries = registry?.plugins?.[pluginKey];
    if (!Array.isArray(entries)) return [];
    return entries.map((entry) => entry?.installPath).filter((path) => typeof path === "string");
  } catch {
    return [];
  }
}

/** Pipeline: remove personal skills only after their identical plugin copies load. */
export function dropPersonalSkills({ claudeDir, settingsText, names, dryRun = false }) {
  const removed = [];
  const kept = [];
  const enabled = pluginEnabled(settingsText);
  const installPaths = enabled ? pluginInstallPaths(claudeDir) : [];

  for (const name of names) {
    const folder = join(claudeDir, "skills", name);
    const personalFile = join(folder, "SKILL.md");
    if (!existsSync(personalFile)) continue;
    if (!enabled) {
      kept.push({ path: folder, reason: "the plugin is not enabled" });
      continue;
    }

    const pluginFile = installPaths
      .map((path) => join(path, "skills", name, "SKILL.md"))
      .find((path) => existsSync(path));
    if (!pluginFile) {
      kept.push({ path: folder, reason: "the plugin copy is not installed" });
      continue;
    }
    if (!readFileSync(personalFile).equals(readFileSync(pluginFile))) {
      kept.push({ path: folder, reason: "it differs from the plugin copy" });
      continue;
    }
    if (readdirSync(folder).some((entry) => entry !== "SKILL.md")) {
      kept.push({ path: folder, reason: "it holds files besides SKILL.md" });
      continue;
    }

    if (!dryRun) rmSync(folder, { recursive: true });
    removed.push(folder);
  }

  return { removed, kept };
}
