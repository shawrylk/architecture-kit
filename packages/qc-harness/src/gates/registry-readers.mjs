// A registry entry's reader list stays true: each reader exists, and each one names the entry.

import { escape } from "../eslint/options.mjs";

/**
 * @param {{key: string, readers: string[]}[]} entries  registry entries, from readerEntries()
 * @param {Map<string, string|null>} sources  reader path to its text, null when the file is absent
 */
export function checkRegistryReaders(entries, sources) {
  const problems = [];
  for (const { key, readers } of entries) {
    // The key as a string or as the accessor's property: "holdpress" and gates.holdpress both hold it.
    const named = new RegExp(`\\b${escape(key)}\\b`);
    for (const reader of readers) {
      const source = sources.get(reader) ?? null;
      if (source === null) {
        problems.push({ path: reader, rule: "missing-reader", detail: `registry entry '${key}' names this reader, and the file does not exist` });
      } else if (!named.test(source)) {
        problems.push({ path: reader, rule: "silent-reader", detail: `registry entry '${key}' names this reader, and the file never names '${key}'` });
      }
    }
  }
  return problems;
}
