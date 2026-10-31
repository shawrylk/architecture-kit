// A pipeline that synchronizes the kit's shared user settings.

import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isDeepStrictEqual } from "node:util";
import { captureCodexConfig, mergeCodexConfig } from "./user-config-toml.mjs";

export { captureCodexConfig, mergeCodexConfig } from "./user-config-toml.mjs";

export const CLAUDE_KEYS = Object.freeze([
  "cleanupPeriodDays", "syncClaudeAiPlugins", "env", "permissions", "autoMode", "model", "skillOverrides",
  "statusLine", "enabledPlugins", "extraKnownMarketplaces", "effortLevel", "modelSettings",
  "awaySummaryEnabled", "autoUpdatesChannel", "tui", "skipWorkflowUsageWarning", "theme",
  "autoCompactEnabled", "autoContinueAtUsageLimit", "agentPushNotifEnabled", "skipAutoPermissionPrompt",
]);
const ENV_KEYS = ["CLAUDE_CODE_DISABLE_MOUSE", "CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP"];
const AUTO_MODE_KEYS = ["environment", "allow", "soft_deny", "hard_deny"];
const MAP_KEYS = ["enabledPlugins", "extraKnownMarketplaces", "env"];
const STATUS_COMMAND = 'node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline.js"';
const USAGE = "qc user-config apply|check|capture [--dry-run] [--kit-dir <path>] [--claude-dir <path>] [--codex-dir <path>]";

export function assertSafePath(file) {
  const name = file.replaceAll("\\", "/").split("/").at(-1).toLowerCase();
  if ([".claude.json", ".credentials.json", "auth.json"].includes(name) || /token|secret|credential|auth(?!or(?:$|[^a-z0-9]))/i.test(name)) {
    throw new Error(`Refusing credential file: ${file}`);
  }
}

function safeFile(file) {
  assertSafePath(file);
  if (existsSync(file)) {
    assertSafePath(realpathSync(file));
    if (!statSync(file).isFile()) throw new Error(`Expected a regular file: ${file}`);
  }
}

export function configPaths(home = os.homedir(), env = process.env) {
  const paths = /^[A-Za-z]:[\\/]|^\\\\/.test(home) ? path.win32 : path.posix;
  const claudeDir = env.CLAUDE_CONFIG_DIR || paths.join(home, ".claude");
  const codexDir = env.CODEX_HOME || paths.join(home, ".codex");
  return { claude: paths.join(claudeDir, "settings.json"), statusline: paths.join(claudeDir, "statusline.js"), codex: paths.join(codexDir, "config.toml") };
}

function objectOf(text) {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON settings object");
  return value;
}

function sharedClaude(text) {
  const source = objectOf(text);
  const shared = Object.fromEntries(CLAUDE_KEYS.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]));
  if (shared.env) shared.env = Object.fromEntries(ENV_KEYS.filter((key) => Object.hasOwn(shared.env, key)).map((key) => [key, shared.env[key]]));
  if (shared.permissions) shared.permissions = Object.fromEntries(["defaultMode", "allow", "deny"].filter((key) => Object.hasOwn(shared.permissions, key)).map((key) => [key, shared.permissions[key]]));
  if (shared.autoMode) shared.autoMode = Object.fromEntries(AUTO_MODE_KEYS.filter((key) => Object.hasOwn(shared.autoMode, key)).map((key) => [key, shared.autoMode[key]]));
  if (shared.statusLine) shared.statusLine = { type: "command", command: STATUS_COMMAND };
  const local = new Set(["skills-dir"]);
  if (shared.extraKnownMarketplaces) {
    shared.extraKnownMarketplaces = Object.fromEntries(Object.entries(shared.extraKnownMarketplaces).filter(([name, entry]) => {
      const remote = ["github", "git"].includes(entry?.source?.source);
      if (!remote) local.add(name);
      return remote;
    }));
  }
  if (shared.enabledPlugins) shared.enabledPlugins = Object.fromEntries(Object.entries(shared.enabledPlugins).filter(([name]) => !local.has(name.split("@").at(-1))));
  return shared;
}

/** Fragment: merges environment lines by their bold label, preserving local order. */
function mergeEnvironment(local, shared) {
  const labelOf = (line) => /^\*\*([^*]+)\*\*:/.exec(line)?.[1];
  const lines = [...new Set(local)];
  for (const line of shared) {
    const label = labelOf(line);
    const index = label === undefined ? -1 : lines.findIndex((entry) => labelOf(entry) === label);
    if (index >= 0) lines[index] = line;
    else if (!lines.includes(line)) lines.push(line);
  }
  const seenLabels = new Set();
  const seenLines = new Set();
  return lines.filter((line) => {
    const label = labelOf(line);
    if (seenLines.has(line) || (label !== undefined && seenLabels.has(label))) return false;
    seenLines.add(line);
    if (label !== undefined) seenLabels.add(label);
    return true;
  });
}

/** Fragment: selects the merge rule for a shared settings entry. */
function mergeEntry(key, name, local, shared) {
  if (key === "autoMode" && name === "environment") return mergeEnvironment(local ?? [], shared);
  if (key === "autoMode" || (key === "permissions" && ["allow", "deny"].includes(name))) {
    return [...new Set([...(local ?? []), ...shared])];
  }
  return shared;
}

export function mergeClaudeSettings(local, shared) {
  const target = objectOf(local);
  const source = sharedClaude(shared);
  const changed = [];
  for (const [key, value] of Object.entries(source)) {
    if ([...MAP_KEYS, "permissions", "autoMode"].includes(key)) {
      const before = target[key] ?? {};
      const merged = { ...before };
      for (const [name, entry] of Object.entries(value)) {
        const next = mergeEntry(key, name, before[name], entry);
        if (!isDeepStrictEqual(before[name], next)) { changed.push(`${key}.${name}`); Object.defineProperty(merged, name, { value: next, enumerable: true, writable: true, configurable: true }); }
      }
      target[key] = merged;
    } else if (!isDeepStrictEqual(target[key], value)) { changed.push(key); target[key] = value; }
  }
  return { text: changed.length ? `${JSON.stringify(target, null, 2)}\n` : local, changed };
}

export function kitUserConfigDir(moduleUrl = import.meta.url) {
  const packageDir = fileURLToPath(new URL("../../user-config/", moduleUrl));
  const checkoutDir = fileURLToPath(new URL("../../../../user-config/", moduleUrl));
  const plugin = fileURLToPath(new URL("../../../../.claude-plugin/plugin.json", moduleUrl));
  return existsSync(plugin) && existsSync(checkoutDir) ? checkoutDir : packageDir;
}

function readOptional(file, fallback) {
  try { return readFileSync(file, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function stamp(now) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function backupFile(file, now) {
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file)) copyFileSync(file, `${file}.bak-${stamp(now)}`, constants.COPYFILE_EXCL);
}

export async function runUserConfig(args, options = {}) {
  const log = options.log ?? console.log;
  try {
    for (const arg of args) assertSafePath(arg);
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      "dry-run": { type: "boolean" }, "kit-dir": { type: "string" }, "claude-dir": { type: "string" }, "codex-dir": { type: "string" },
    } });
    const [verb] = positionals;
    if (positionals.length !== 1 || !["apply", "check", "capture"].includes(verb)) throw new Error(USAGE);
    const env = { ...(options.env ?? process.env) };
    if (values["claude-dir"]) env.CLAUDE_CONFIG_DIR = values["claude-dir"];
    if (values["codex-dir"]) env.CODEX_HOME = values["codex-dir"];
    const paths = configPaths(options.home ?? os.homedir(), env);
    const kit = values["kit-dir"] ?? options.kitDir ?? kitUserConfigDir();
    const files = [
      { machine: paths.claude, kit: path.join(kit, "claude/settings.shared.json"), fallback: "{}", merge: mergeClaudeSettings, capture: (text) => `${JSON.stringify(sharedClaude(text), null, 2)}\n` },
      { machine: paths.codex, kit: path.join(kit, "codex/config.shared.toml"), fallback: "", merge: mergeCodexConfig, capture: captureCodexConfig },
      { machine: paths.statusline, kit: path.join(kit, "claude/statusline.js"), fallback: "", merge: (local, shared) => ({ text: shared, changed: local === shared ? [] : ["statusline.js"] }), capture: (text) => text },
    ];
    for (const file of files) { safeFile(file.machine); safeFile(file.kit); }
    const plans = files.map((file) => {
      const target = verb === "capture" ? file.kit : file.machine;
      const local = readOptional(target, file.fallback);
      const source = readFileSync(verb === "capture" ? file.machine : file.kit, "utf8");
      const result = verb === "capture" ? { text: file.capture(source), changed: [path.basename(file.kit)] } : file.merge(local, source);
      return { target, ...result, changed: result.text === local ? [] : result.changed };
    });
    for (const plan of plans) {
      for (const key of plan.changed) log(`${values["dry-run"] ? "Would change" : verb === "check" ? "Drift" : "Change"} ${plan.target}: ${key}`);
    }
    if (verb !== "check" && !values["dry-run"]) {
      const changes = plans.filter((plan) => plan.changed.length);
      const now = options.now ?? new Date();
      for (const plan of changes) backupFile(plan.target, now);
      for (const plan of changes) writeFileSync(plan.target, plan.text, { mode: 0o600 });
    }
    const drift = plans.some((plan) => plan.changed.length);
    return verb === "check" && drift ? 1 : 0;
  } catch (error) {
    (options.log ?? console.error)(`qc user-config: ${error.message}`);
    return 2;
  }
}
