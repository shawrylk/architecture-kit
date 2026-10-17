// A component is described before anyone can reuse it. Every exported component under the configured
// roots carries a JSDoc sentence, and the generated catalog matches the code. A baseline lists the
// components that predate the gate; an entry that no longer fails is an error, so the list only shrinks.

import { sameCatalog } from "../ui/catalog.mjs";

const keyOf = (entry) => `${entry.path}#${entry.name}`;

/**
 * @param {{name: string, path: string, line: number, description: string}[]} entries
 * @param {{catalog: {path: string, actual: string | null, expected: string | null, command: string}, baseline: string[] | null, baselineFile: string}} options
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkUiCatalog(entries, { catalog, baseline, baselineFile }) {
  const problems = [];
  const excused = new Set(baseline ?? []);
  const failing = new Set();

  for (const entry of entries) {
    if (entry.description !== "") continue;
    failing.add(keyOf(entry));
    if (excused.has(keyOf(entry))) continue;
    problems.push({
      path: `${entry.path}:${entry.line}`,
      rule: "undocumented-component",
      detail: `${entry.name} is exported with no JSDoc sentence; describe what it is for, so a reader can find it in the catalog before writing another`,
    });
  }
  for (const key of [...excused].sort()) {
    if (failing.has(key)) continue;
    problems.push({
      path: baselineFile,
      rule: "stale-baseline",
      detail: `${key} no longer fails; remove it from the baseline, or run \`qc ui catalog --baseline\``,
    });
  }
  if (!sameCatalog(catalog.actual, catalog.expected)) {
    const detail =
      catalog.expected === null
        ? `lists no component any more; remove it with \`${catalog.command}\``
        : `is ${catalog.actual === null ? "missing" : "stale"}; write it with \`${catalog.command}\``;
    problems.push({ path: catalog.path, rule: "stale-catalog", detail });
  }
  return problems;
}
