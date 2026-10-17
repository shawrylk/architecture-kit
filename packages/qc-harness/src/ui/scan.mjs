// The I/O side of the UI tools: list the repository, read the component files, parse them, and write the
// catalog. A repository's codegen imports `writeCatalog` from `architecture-harness/ui/scan` so that its
// own codegen command writes the catalog, as it writes every other generated file.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ignoresOf } from "../config.mjs";
import { globMatcher } from "../glob.mjs";
import { repoFiles } from "../cli/repo-files.mjs";
import { baselineOf, catalogEntries, renderCatalog } from "./catalog.mjs";
import { componentFileMatcher, expandBraces, uiOptions } from "./options.mjs";
import { loadTypeScript } from "./typescript.mjs";

/** What writes the catalog: this command, or a codegen that calls `writeCatalog`. */
export const CATALOG_COMMAND = "qc ui catalog";

const read = (file) => readFile(file, "utf8").catch(() => null);

export function requireTypeScript(root) {
  const ts = loadTypeScript(root);
  if (!ts) throw new Error("the UI tools read TSX with the TypeScript compiler API, and `typescript` resolves from neither this repository nor the harness; install it");
  return ts;
}

/** Read each listed file. One the listing names but the disk no longer holds is skipped. */
export async function readFiles(root, rels) {
  const files = [];
  for (const rel of rels) {
    const contents = await read(path.join(root, rel));
    if (contents !== null) files.push({ path: rel, contents });
  }
  return files;
}

/** @param {string[]} [listed] the repository's files, when a caller already holds them */
export async function listFiles(config, listed) {
  return listed ?? (await repoFiles(config.root, { ignores: ignoresOf(config) }));
}

/**
 * Every exported component under the roots.
 * @returns {Promise<{options: object, files: {path: string, contents: string}[], entries: object[], ts: object | null}>}
 *   `ts` is null when no component file exists, and then TypeScript was never loaded
 */
export async function scanComponents(config, listed) {
  const options = uiOptions(config);
  const inRoots = componentFileMatcher(options);
  const files = await readFiles(config.root, (await listFiles(config, listed)).filter(inRoots));
  if (files.length === 0) return { options, files, entries: [], ts: null };
  const ts = requireTypeScript(config.root);
  return { options, files, entries: catalogEntries(ts, options, files, config.featureDir), ts };
}

/** The text the catalog file should hold, or null when there is no component. */
export const catalogText = (entries, options) => renderCatalog(entries, { layers: options.layers, command: CATALOG_COMMAND });

/** Write the catalog, or remove it when no component is left. @returns {Promise<{path: string, entries: number}>} */
export async function writeCatalog(config, listed) {
  const { options, entries } = await scanComponents(config, listed);
  const file = path.join(config.root, options.catalog);
  const text = catalogText(entries, options);
  if (text === null) {
    await rm(file, { force: true });
  } else {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  return { path: options.catalog, entries: entries.length };
}

export const writeCatalogBaseline = (config, entries, options) =>
  writeFile(path.join(config.root, options.catalogBaseline), `${JSON.stringify(baselineOf(entries), null, 2)}\n`);

/** The files the codemod walks: the client globs, TypeScript and TSX only. */
export async function clientSourceFiles(config, listed) {
  const matches = globMatcher((config.clientFiles ?? []).flatMap(expandBraces));
  return readFiles(config.root, (await listFiles(config, listed)).filter((rel) => /\.tsx?$/.test(rel) && matches(rel)));
}
