// The registries a doc check and the lint rule both read: the thresholds, the versions, and each
// item of `registryLiteral.registries`. Sync, so the ESLint preset can call it.

import { readFileSync } from "node:fs";
import path from "node:path";

const readText = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

function parsedJson(source) {
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

const PREFIX_WORD = /^\w+$/;

/** Why a `registryLiteral.registries` item cannot be used, or null. */
function unusable(item) {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return "is no object";
  const { path: file, key, prefix, valueKey, unitKey } = item;
  if (typeof file !== "string" || file === "") return "needs a path";
  if (typeof key !== "string" || key === "") return "needs a key";
  const prefixes = [prefix].flat();
  if (prefixes.length === 0 || !prefixes.every((word) => typeof word === "string" && PREFIX_WORD.test(word))) {
    return "needs a prefix: a word, or a list of words";
  }
  const named = [["valueKey", valueKey], ["unitKey", unitKey]].find(([, name]) => name !== undefined && (typeof name !== "string" || name === ""));
  return named ? `has a ${named[0]} that is no string` : null;
}

/** The entries of one registry file. A built-in registry whose file or key is absent has none. */
function registryEntries(config, { path: file, key, builtIn }) {
  const source = readText(path.join(config.root, file));
  if (source === null) return builtIn ? { entries: {} } : { problem: `${file} is missing` };
  const parsed = parsedJson(source);
  if (parsed === null || typeof parsed !== "object") return { problem: `${file} is not a JSON object` };
  const entries = parsed[key];
  if (entries === undefined && builtIn) return { entries: {} };
  if (entries === null || typeof entries !== "object" || Array.isArray(entries)) return { problem: `${file} holds no object under '${key}'` };
  return { entries };
}

/**
 * The registries the doc check reads: the thresholds and the versions, each replaced by a configured
 * item of the same path, and every other configured item after them.
 */
export function literalRegistries(config) {
  const configured = config.registryLiteral.registries ?? [];
  const problems = [];
  const fail = (detail) => problems.push({ path: "qc.config.json", rule: "registry-literal", detail });
  if (!Array.isArray(configured)) fail("registryLiteral.registries is no list");
  const sources = [
    { path: config.thresholds, key: "gates", prefix: "q", builtIn: true },
    { path: config.versions, key: "libraries", prefix: ["ver", "v"], valueKey: "version", builtIn: true },
  ];
  (Array.isArray(configured) ? configured : []).forEach((item, index) => {
    const why = unusable(item);
    if (why) return fail(`registryLiteral.registries[${index}] ${why}`);
    const same = sources.findIndex((source) => source.builtIn && path.normalize(source.path) === path.normalize(item.path));
    if (same >= 0) sources[same] = item;
    else sources.push(item);
  });
  const list = [];
  const claimed = new Map();
  for (const source of sources) {
    const prefixes = [...new Set([source.prefix].flat())];
    const taken = prefixes.find((prefix) => claimed.has(prefix));
    if (taken !== undefined) {
      fail(`the prefix '${taken}' of ${source.path} is already the prefix of ${claimed.get(taken)}`);
      continue;
    }
    const { entries, problem } = registryEntries(config, source);
    if (problem) {
      fail(problem);
      continue;
    }
    for (const prefix of prefixes) claimed.set(prefix, source.path);
    list.push({ path: source.path, entries, prefixes, valueKey: source.valueKey, unitKey: source.unitKey });
  }
  return { list, problems };
}
