// The component catalog: every exported component under the configured roots, one markdown table per
// layer. It is generated and never edited by hand, so an agent reads it to find a component before it
// writes a new one.

import { extractComponents, layerOf } from "./components.mjs";
import { componentFileMatcher } from "./options.mjs";

const lf = (text) => text.replace(/\r\n/g, "\n");
const cell = (text) => text.replace(/\|/g, "\\|");

/**
 * @param ts the TypeScript module
 * @param options the resolved `ui` block
 * @param {{path: string, contents: string}[]} files the listed source files, any of them
 * @param {string} [featureDir] the path segment that marks a feature
 * @returns {{name: string, path: string, line: number, props: string[], description: string, layer: string}[]}
 */
export function catalogEntries(ts, options, files, featureDir = "features") {
  const inRoots = componentFileMatcher(options);
  const entries = [];
  for (const file of files) {
    if (!inRoots(file.path) || !/\bexport\b/.test(file.contents)) continue;
    for (const component of extractComponents(ts, file.path, file.contents)) {
      entries.push({ ...component, layer: layerOf(file.path, options, featureDir) });
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

/** The layers in reading order: those configured, then `platform`, then each feature, then any other. */
function orderedLayers(layers, configured) {
  const rank = (layer) => {
    const named = configured.indexOf(layer);
    if (named !== -1) return [0, named, layer];
    if (layer === "platform") return [1, 0, layer];
    return [layer.startsWith("feature:") ? 2 : 3, 0, layer];
  };
  return [...layers].sort((a, b) => {
    const [ka, na, la] = rank(a);
    const [kb, nb, lb] = rank(b);
    return ka - kb || na - nb || la.localeCompare(lb);
  });
}

/**
 * @param {object[]} entries from `catalogEntries`
 * @param {{layers: Record<string, string>, command: string}} options `command` is what writes the file
 * @returns {string | null} null when there is no component, so no file is owed
 */
export function renderCatalog(entries, { layers, command }) {
  if (entries.length === 0) return null;
  const byLayer = Map.groupBy(entries, (entry) => entry.layer);
  const sections = orderedLayers(byLayer.keys(), Object.keys(layers)).map((layer) => {
    const rows = byLayer.get(layer).map((entry) => {
      const props = entry.props.map((prop) => `\`${prop}\``).join(", ");
      return `| \`${entry.name}\` | \`${entry.path}\` | ${props} | ${cell(entry.description) || "none"} |`;
    });
    return `## ${layer}\n\n| Component | Path | Props | Description |\n|---|---|---|---|\n${rows.join("\n")}`;
  });
  return [
    `<!-- generated: ui-catalog. Run \`${command}\` to write this file; never edit it by hand. -->`,
    "",
    "# UI component catalog",
    "",
    "Find a component here before you write one. `qc ui find <words>` ranks these entries.",
    "",
    sections.join("\n\n"),
    "",
    "<!-- /generated -->",
    "",
  ].join("\n");
}

/** True when the file on disk is the text the scan produced. Both null is a repository with nothing to list. */
export function sameCatalog(actual, expected) {
  if (actual === null || expected === null) return actual === expected;
  return lf(actual) === lf(expected);
}

/** The baseline file's content: the components that have no sentence today, so the list only shrinks. */
export function baselineOf(entries) {
  const undocumented = entries
    .filter((entry) => entry.description === "")
    .map((entry) => `${entry.path}#${entry.name}`)
    .sort();
  return { undocumented };
}
