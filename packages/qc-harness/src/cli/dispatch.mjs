// The branch that judges one Agent dispatch against `swarm.dispatch`: a named model or an allowed
// type, and a prompt short enough to point at a brief file. The implementer slot is dispatch-slot's.

import { existsSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILE, MODEL_FAMILIES, dispatchDefaults, exploreDefaults, load, merge } from "../config.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";

const KEY = "swarm.dispatch";
const EXPLORE_KEY = "swarm.explore";
const DEFAULT_TYPE = "general-purpose";
const FORK = "fork";
const WILDCARD_TYPE = "*";

const isNameList = (value) => Array.isArray(value) && value.every((name) => typeof name === "string" && name !== "");
const isFamilyList = (value) => Array.isArray(value) && value.length > 0 && value.every((name) => MODEL_FAMILIES.includes(name));
const wrong = (key, value, want) =>
  new Error(`${KEY}.${key} in qc.config.json must be ${want}, got ${JSON.stringify(value)}`);

function checkModels(models) {
  const wantFamilies = `a non-empty list of known families (${MODEL_FAMILIES.join(", ")})`;
  if (typeof models !== "object" || models === null || Array.isArray(models)) {
    throw wrong("models", models, "an object mapping an agent type to its model families");
  }
  for (const [type, families] of Object.entries(models)) {
    if (!isFamilyList(families)) throw wrong(`models.${type}`, families, wantFamilies);
  }
}

/** The first family name a model string contains, lower-cased. Null when it names none the guard knows. */
export function familyOf(model) {
  const lower = model.toLowerCase();
  return MODEL_FAMILIES.find((family) => lower.includes(family)) ?? null;
}

/** @returns the dispatch settings, or null when the section is absent; throws naming the key a repository got wrong. */
export function dispatchSettings(swarm = {}) {
  const raw = swarm.dispatch;
  if (raw === undefined || raw === null || raw === false) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${KEY} in qc.config.json must be an object, got ${JSON.stringify(raw)}`);
  }
  const { allowedTypes, implementerTypes, maxPromptChars, slotMinutes, implementerSlots, models } = merge(
    dispatchDefaults,
    raw,
  );
  if (!isNameList(allowedTypes)) throw wrong("allowedTypes", allowedTypes, "a list of agent types");
  if (!isNameList(implementerTypes)) throw wrong("implementerTypes", implementerTypes, "a list of agent types");
  if (!Number.isInteger(maxPromptChars) || maxPromptChars < 1) {
    throw wrong("maxPromptChars", maxPromptChars, "a positive whole number");
  }
  if (typeof slotMinutes !== "number" || !(slotMinutes > 0)) throw wrong("slotMinutes", slotMinutes, "a positive number");
  if (!Number.isInteger(implementerSlots) || implementerSlots < 1) {
    throw wrong("implementerSlots", implementerSlots, "a positive whole number");
  }
  checkModels(models);
  return { allowedTypes, implementerTypes, maxPromptChars, slotMinutes, implementerSlots, models };
}

/** @returns the settings of the checkout that holds `cwd`, or null when it has no config or no section. */
export function dispatchSettingsAt(cwd) {
  const root = checkoutRootOf(cwd);
  if (!root || !existsSync(path.join(root, CONFIG_FILE))) return null;
  return dispatchSettings(load(root).swarm);
}

const isToolEntry = (entry) =>
  isPlainRecord(entry) && ["name", "use", "how"].every((key) => typeof entry[key] === "string" && entry[key] !== "");
const isPlainRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const wrongExplore = (key, value, want) =>
  new Error(`${EXPLORE_KEY}.${key} in qc.config.json must be ${want}, got ${JSON.stringify(value)}`);

/** @returns the explore settings, or null when the section is absent; throws naming the key a repository got wrong. */
export function exploreSettings(swarm = {}) {
  const raw = swarm.explore;
  if (raw === undefined || raw === null || raw === false) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${EXPLORE_KEY} in qc.config.json must be an object, got ${JSON.stringify(raw)}`);
  }
  const { tools, summarizer, maxReadLines, maxGrepLines, maxOutputChars, exempt } = merge(exploreDefaults, raw);
  if (!Array.isArray(tools) || !tools.every(isToolEntry)) {
    throw wrongExplore("tools", tools, 'a list of { "name", "use", "how" } strings');
  }
  if (summarizer !== null && (typeof summarizer !== "string" || summarizer === "")) {
    throw wrongExplore("summarizer", summarizer, "a non-empty string or null");
  }
  for (const [key, value] of [
    ["maxReadLines", maxReadLines],
    ["maxGrepLines", maxGrepLines],
    ["maxOutputChars", maxOutputChars],
  ]) {
    if (!Number.isInteger(value) || value < 1) throw wrongExplore(key, value, "a positive whole number");
  }
  if (!isNameList(exempt)) throw wrongExplore("exempt", exempt, "a list of globs");
  return { tools, summarizer, maxReadLines, maxGrepLines, maxOutputChars, exempt };
}

/** @returns the explore settings of the checkout that holds `cwd`, or null when it has no config or no section. */
export function exploreSettingsAt(cwd) {
  const root = checkoutRootOf(cwd);
  if (!root || !existsSync(path.join(root, CONFIG_FILE))) return null;
  return exploreSettings(load(root).swarm);
}

/** One `- name: use (how)` line per explore tool: the form every explore note and refusal shares. */
export const exploreToolLines = (tools) => tools.map((tool) => `- ${tool.name}: ${tool.use} (${tool.how})`);

/** The type a dispatch names, trimmed. The Agent tool runs general-purpose when it names none. */
export const typeOf = (input) =>
  typeof input.subagent_type === "string" && input.subagent_type.trim() !== "" ? input.subagent_type.trim() : DEFAULT_TYPE;

export const isImplementer = (type, settings) => settings.implementerTypes.includes(type);

function modelRefusal(type, settings) {
  const allowed = settings.allowedTypes.join(", ");
  if (type === FORK) {
    return (
      "Dispatch guard: a fork runs on the session's model whatever `model` says, so it passes only when " +
      `\`fork\` is in ${KEY}.allowedTypes in qc.config.json. Dispatch one of: ${allowed}, or another type with a model.`
    );
  }
  return (
    `Dispatch guard: the dispatch names no model, so the ${type} agent runs on the session's model. ` +
    `Pass \`model\` with the cheapest tier that fits the task, or dispatch one of: ${allowed}. ` +
    `To allow another type with no model, add it to ${KEY}.allowedTypes in qc.config.json.`
  );
}

const promptRefusal = (length, max) =>
  `Dispatch guard: the prompt has ${length} characters, over ${KEY}.maxPromptChars (${max}) in qc.config.json. ` +
  "Write the brief to a file, and send a short prompt that names the brief and the report file.";

function tierRefusal(type, model, families) {
  return (
    `Dispatch guard: ${type} may run only on ${families.join(", ")}, so it refuses model "${model}". ` +
    `Name a model of one of those families, or dispatch a type in ${KEY}.models with one that fits.`
  );
}

/** @returns the reason a named model breaks its type's tier, or null when it fits. */
function tierRefusalFor(type, model, settings) {
  const families = settings.models[type] ?? settings.models[WILDCARD_TYPE];
  const family = familyOf(model);
  if (family && families.includes(family)) return null;
  return tierRefusal(type, model, families);
}

/** @returns the reason the dispatch breaks a rule that needs no state, or null to let it through. */
export function dispatchRefusal(input, settings) {
  const type = typeOf(input);
  const model = typeof input.model === "string" ? input.model.trim() : "";
  const allowed = settings.allowedTypes.includes(type);
  if (!allowed && (type === FORK || model === "")) return modelRefusal(type, settings);
  if (model !== "" && type !== FORK) {
    const refusal = tierRefusalFor(type, model, settings);
    if (refusal) return refusal;
  }
  const length = typeof input.prompt === "string" ? input.prompt.length : 0;
  if (length > settings.maxPromptChars) return promptRefusal(length, settings.maxPromptChars);
  return null;
}

/** The reason an implementer over the limit waits, with the two ways a slot frees. */
export function slotRefusal({ type, claimedAt, expiresAt, slotFile, limit = 1, holders = [] }) {
  const frees = `If no implementer runs, because its dispatch was denied after this hook, delete ${slotFile}.`;
  if (limit === 1) {
    return (
      `Dispatch guard: an implementer holds the one implementer slot of this session since ${claimedAt.toISOString()}. ` +
      `Wait for it to stop, then dispatch ${type}. The slot frees when it stops, or at ${expiresAt.toISOString()}. ` +
      frees
    );
  }
  const named = holders.map((holder) => `${holder.id} (since ${holder.claimedAt.toISOString()})`).join(", ");
  return (
    `Dispatch guard: all ${limit} implementer slots of this session are held, by ${named}. ` +
    `Wait for one to stop, then dispatch ${type}. A slot frees when its holder stops, and by ${expiresAt.toISOString()} at the latest. ` +
    frees
  );
}
