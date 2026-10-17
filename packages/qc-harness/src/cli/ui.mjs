// `qc ui`: find a component before writing one, and change class tokens across a frontend in one command.
// Each subcommand is a thin reader over the pure modules in ../ui.

import { readFileSync } from "node:fs";
import { readFile as readFileAsync, writeFile } from "node:fs/promises";
import path from "node:path";
import { baselineOfFindings, findDupes } from "../ui/dupes.mjs";
import { findComponents, formatFound } from "../ui/find.mjs";
import { arbitraryTokens, codemodSource, parseMap, suggest, themeVariables } from "../ui/codemod.mjs";
import { sameCatalog } from "../ui/catalog.mjs";
import { uiOptions } from "../ui/options.mjs";
import {
  CATALOG_COMMAND,
  catalogText,
  clientSourceFiles,
  listFiles,
  readFiles,
  requireTypeScript,
  scanComponents,
  writeCatalog,
  writeCatalogBaseline,
} from "../ui/scan.mjs";

const USAGE = `qc ui — the component catalog, the duplicate finder and the class codemod

  qc ui catalog [--json] [--check] [--baseline]
                           write the catalog; --check exits 1 when it is stale; --baseline writes ui-catalog.baseline.json
  qc ui find <words...> [--json]
                           the eight catalog entries nearest the words, as name — path — description
  qc ui dupes [--json] [--baseline]
                           repeated class strings, repeated component names, near-equal JSX trees
  qc ui codemod --map <json|file> [--write]
                           rewrite whole class tokens in class sites; a dry run unless --write
  qc ui codemod --suggest  every arbitrary-value token with its count, and the @theme variable with its value`;

const say = (line) => console.log(line);

/** `--flag` words and the rest, split. A flag that takes a value is named in `valued`. */
function parse(args, valued = []) {
  const flags = new Map();
  const words = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) words.push(arg);
    else if (valued.includes(arg)) flags.set(arg, args[(index += 1)]);
    else flags.set(arg, true);
  }
  return { flags, words };
}

async function catalog(config, args) {
  const { flags } = parse(args);
  const { options, entries } = await scanComponents(config);
  const expected = catalogText(entries, options);
  if (flags.has("--json")) {
    say(JSON.stringify(entries, null, 2));
    return 0;
  }
  if (flags.has("--check")) {
    const actual = await readFileAsync(path.join(config.root, options.catalog), "utf8").catch(() => null);
    if (sameCatalog(actual, expected)) return 0;
    console.error(`${options.catalog} is stale; run \`${CATALOG_COMMAND}\``);
    return 1;
  }
  if (flags.has("--baseline")) {
    await writeCatalogBaseline(config, entries, options);
    say(`wrote ${options.catalogBaseline}: ${entries.filter((entry) => entry.description === "").length} undocumented component(s)`);
    return 0;
  }
  const written = await writeCatalog(config);
  say(written.entries === 0 ? `no component under ${options.componentRoots.join(", ")}; no catalog` : `wrote ${written.path}: ${written.entries} component(s)`);
  return 0;
}

async function find(config, args) {
  const { flags, words } = parse(args);
  if (words.length === 0) {
    console.error("qc ui find <words...>");
    return 1;
  }
  const { entries } = await scanComponents(config);
  const found = findComponents(entries, words);
  if (flags.has("--json")) say(JSON.stringify(found.map(({ entry, score }) => ({ ...entry, score })), null, 2));
  else for (const one of found) say(formatFound(one));
  return 0;
}

async function dupes(config, args) {
  const { flags } = parse(args);
  const { options, files, entries, ts } = await scanComponents(config);
  const found = ts ? findDupes(ts, files, { entries, callees: options.classCallees, ...options.dupes }) : [];
  if (flags.has("--baseline")) {
    await writeFile(path.join(config.root, options.dupes.baseline), `${JSON.stringify(baselineOfFindings(found), null, 2)}\n`);
    say(`wrote ${options.dupes.baseline}: ${found.length} finding(s)`);
    return 0;
  }
  if (flags.has("--json")) {
    say(JSON.stringify(found, null, 2));
    return 0;
  }
  const titles = { "class-string": "Repeated class strings", "component-name": "Repeated component names", "jsx-tree": "Near-equal JSX trees" };
  for (const kind of Object.keys(titles)) {
    const ofKind = found.filter((one) => one.kind === kind);
    say(`${titles[kind]}: ${ofKind.length}`);
    for (const one of ofKind) {
      const where = one.locations ? one.locations.join(" ~ ") : one.files.join(", ");
      say(`  ${kind === "class-string" ? `"${one.key}"` : one.key}\n    ${where}`);
    }
  }
  return 0;
}

/** The map of `--map`: inline JSON, or the path of a JSON file. */
function mapOf(value, root) {
  if (typeof value !== "string") throw new Error("--map needs a JSON object, or the path of a JSON file");
  const text = value.trimStart().startsWith("{") ? value : readFileSync(path.resolve(root, value), "utf8");
  return parseMap(text);
}

async function stylesheets(config, listed) {
  const css = await readFiles(config.root, listed.filter((rel) => rel.endsWith(".css")));
  return css.filter((file) => file.contents.includes("@theme")).flatMap((file) => themeVariables(file.contents));
}

async function codemod(config, args) {
  const { flags } = parse(args, ["--map"]);
  const options = uiOptions(config);
  const ts = requireTypeScript(config.root);
  const listed = await listFiles(config);
  const files = await clientSourceFiles(config, listed);

  if (flags.has("--suggest")) {
    const counts = new Map();
    for (const file of files) {
      for (const [token, count] of arbitraryTokens(ts, file.path, file.contents, options.classCallees)) counts.set(token, (counts.get(token) ?? 0) + count);
    }
    for (const line of suggest(counts, await stylesheets(config, listed))) {
      say(`${String(line.count).padStart(5)}  ${line.token}${line.variable ? `  ->  ${line.variable}: ${line.value}` : ""}`);
    }
    say(`${counts.size} arbitrary-value token(s)`);
    return 0;
  }

  let map;
  try {
    map = mapOf(flags.get("--map"), config.root);
  } catch (cause) {
    console.error(`qc ui codemod: ${cause.message}`);
    return 1;
  }
  let total = 0;
  let touched = 0;
  for (const file of files) {
    const out = codemodSource(ts, file.path, file.contents, map, options.classCallees);
    if (out.count === 0) continue;
    total += out.count;
    touched += 1;
    say(`${file.path}  ${out.count}`);
    if (flags.has("--write")) await writeFile(path.join(config.root, file.path), out.text);
  }
  say(`${total} token(s) in ${touched} file(s)${flags.has("--write") ? " rewritten" : "; a dry run, pass --write to apply"}`);
  return 0;
}

const COMMANDS = { catalog, find, dupes, codemod };

/** @returns {Promise<number>} the exit code */
export async function runUi(config, args) {
  const [name, ...rest] = args;
  const run = COMMANDS[name];
  if (!run) {
    say(USAGE);
    return name === undefined || name === "help" ? 0 : 1;
  }
  try {
    return await run(config, rest);
  } catch (cause) {
    console.error(`qc ui ${name}: ${cause.message}`);
    return 1;
  }
}
