// QC-007's map, built from the rules and gates themselves so adding one cannot leave it stale.

import { enabled } from "./config.mjs";
import { gateDescriptions } from "./descriptions.mjs";
import { rules } from "./eslint/index.mjs";

export const OPEN = "<!-- generated: rule-to-check. -->";
export const CLOSE = "<!-- /generated -->";
// A repository may annotate the open marker with its own reminder (e.g. "pnpm codegen.") —
// matched by prefix, not by exact string, so that annotation does not break detection.
const OPEN_PATTERN = /<!--\s*generated:\s*rule-to-check\.[^>]*-->/;

function sentence(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** @returns {string} a markdown table of every check in force, one row each. */
export function enforcementMap(config) {
  const rows = [
    ...Object.keys(rules)
      .filter((name) => enabled(config.rules, name))
      .sort()
      .map((name) => `| ${sentence(rules[name].meta.docs.description)} | \`qc/${name}\` |`),
    ...Object.keys(config.gates)
      .filter((name) => enabled(config.gates, name))
      .sort()
      .map((name) => `| ${sentence(gateDescriptions[name])} | \`qc check\` (${name}) |`),
  ];
  return `| Rule | Check |\n|---|---|\n${rows.join("\n")}`;
}

/**
 * Splices the table between the markers, leaving whatever a repository wrote around them —
 * including its own open marker's own text, which this keeps rather than resets to `OPEN`.
 * @returns {string|null} null when no open marker is found, so a caller can tell that apart
 *   from a splice that ran and found nothing to change.
 */
export function withEnforcementMap(markdown, config) {
  const found = OPEN_PATTERN.exec(markdown);
  if (!found) return null;
  const at = found.index;
  const openText = found[0];
  const after = markdown.indexOf(CLOSE, at);
  const tail = after === -1 ? "" : markdown.slice(after + CLOSE.length);
  return `${markdown.slice(0, at)}${openText}\n\n${enforcementMap(config)}\n\n${CLOSE}${tail}`;
}
