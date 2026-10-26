import { mergeCodexConfig } from "./user-config-toml.mjs";

/** Fragment: read optional compaction budgets from the project config. */
export function budgetsOf(configText) {
  let config;
  try {
    config = configText === null ? {} : JSON.parse(configText);
  } catch (cause) {
    throw new Error("qc.config.json must contain valid JSON", { cause });
  }
  const budgets = {};
  for (const agent of ["orchestrator", "codex"]) {
    const value = config?.budgets?.[agent]?.compactAt;
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`budgets.${agent}.compactAt must be a positive whole number`);
    }
    budgets[agent] = value ?? null;
  }
  return budgets;
}

/** Fragment: enable Claude compaction and merge the selected model windows. */
export function compactClaude(configText, { models, window }) {
  let settings;
  try {
    settings = JSON.parse(configText || "{}");
  } catch (cause) {
    throw new Error("Claude settings must be a JSON settings object", { cause });
  }
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("Claude settings must be a JSON settings object");
  }

  const changed = [];
  if (settings.autoCompactEnabled !== true) {
    settings.autoCompactEnabled = true;
    changed.push("autoCompactEnabled");
  }
  if (window !== null) {
    for (const name of models) {
      const modelSettings = settings.modelSettings ??= {};
      const model = modelSettings[name] ??= {};
      if (model.autoCompactWindow === window) continue;
      model.autoCompactWindow = window;
      changed.push(`modelSettings.${name}.autoCompactWindow`);
    }
  }
  return { text: changed.length ? JSON.stringify(settings, null, 2) + "\n" : configText, changed };
}

/** Fragment: merge the Codex compaction limit while preserving other TOML settings. */
export function compactCodex(configText, limit) {
  if (limit === null) return { text: configText, changed: [] };
  return mergeCodexConfig(configText, `model_auto_compact_token_limit = ${limit}\n`);
}
