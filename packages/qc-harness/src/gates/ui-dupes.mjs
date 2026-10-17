// The same UI is written once. A repeated class string, two components of one name, and two near-equal
// JSX trees fail unless a baseline holds them; a baseline entry that no longer occurs fails too, so the
// baseline only shrinks.

import { findingId } from "../ui/dupes.mjs";

const SAY = {
  "class-string": "the same class string",
  "component-name": "an exported component of the same name",
  "jsx-tree": "a JSX tree that differs by a class or two",
};

/**
 * @param {{kind: string, key: string, files: string[]}[]} findings
 * @param {{baseline: string[] | null, baselineFile: string}} options `baseline` holds finding ids
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkUiDupes(findings, { baseline, baselineFile }) {
  const excused = new Set(baseline ?? []);
  const present = new Set(findings.map(findingId));
  const problems = [];
  for (const finding of findings) {
    if (excused.has(findingId(finding))) continue;
    const shown = finding.kind === "class-string" ? `"${finding.key.slice(0, 80)}${finding.key.length > 80 ? "..." : ""}"` : finding.key;
    problems.push({
      path: finding.files[0],
      rule: `duplicate-${finding.kind}`,
      detail: `${SAY[finding.kind] ?? finding.kind} (${shown}) is in ${finding.files.join(", ")}; reuse one, or extract it, or run \`qc ui dupes --baseline\``,
    });
  }
  for (const id of [...excused].sort()) {
    if (present.has(id)) continue;
    problems.push({ path: baselineFile, rule: "stale-baseline", detail: `${id} no longer occurs; remove it from the baseline` });
  }
  return problems;
}
