// A number a registry owns is written in the docs as a token, never as the figure. A figure goes
// stale the day the registry moves, and nothing else would notice.

import { escape } from "../eslint/options.mjs";
import { globMatcher } from "../glob.mjs";

// The token prefixes of the two registries a repository has without a configured list.
const BUILT_IN = [
  { prefixes: ["q"], from: "thresholds" },
  { prefixes: ["ver", "v"], from: "libraries", valueKey: "version" },
];
// Words between a phrase and a number, at most. Past that the number belongs to another sentence.
const WINDOW = 6;
const NUMBER = /^(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(%|[a-z]+)?$/;
const UNIT_SPELLINGS = {
  percent: ["%", "percent"],
  ms: ["ms", "millisecond", "milliseconds"],
  s: ["s", "second", "seconds"],
  px: ["px", "pixel", "pixels"],
  lines: ["line", "lines"],
  days: ["day", "days"],
  months: ["month", "months"],
  count: [],
};

const spellings = (unit) => UNIT_SPELLINGS[unit] ?? (unit ? [unit, unit.replace(/s$/, "")] : []);

/** Lowercase, with the punctuation around a word gone. A trailing `%` stays: it is the unit. */
const normal = (word) => word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}%]+$/gu, "");

/** Each entry that states its phrases, with the units that are its own. */
function thresholdEntries({ entries, prefixes, valueKey = "value", unitKey = "unit" }) {
  return Object.entries(entries)
    .filter(([, entry]) => typeof entry[valueKey] === "number" && entry.match?.length > 0)
    .map(([key, entry]) => ({
      key,
      prefix: prefixes[0],
      value: entry[valueKey],
      unit: entry[unitKey],
      own: new Set(spellings(entry[unitKey])),
      phrases: entry.match.map((phrase) => phrase.split(/\s+/).map(normal).filter(Boolean)),
    }));
}

/** The unit a number carries: attached as `70%`, or the next word as `70 percent`. */
function unitOf(words, index, attached, known) {
  if (attached) return attached;
  const next = words[index + 1]?.norm;
  return next !== undefined && known.has(next) ? next : "";
}

/** The word ranges where a phrase stands. */
function phraseSpans(words, phrases) {
  const spans = [];
  for (const phrase of phrases) {
    for (let start = 0; start + phrase.length <= words.length; start += 1) {
      if (phrase.every((part, offset) => words[start + offset].norm === part)) spans.push([start, start + phrase.length - 1]);
    }
  }
  return spans;
}

const near = (index, [start, end]) => (index > end ? index - end - 1 : start - index - 1) <= WINDOW;

function thresholdProblems(file, words, entries, known) {
  const problems = [];
  const spansOf = new Map(entries.map((entry) => [entry, phraseSpans(words, entry.phrases)]));
  words.forEach((word, index) => {
    const found = NUMBER.exec(word.norm);
    if (found === null) return;
    const value = Number(found[1].replaceAll(",", ""));
    const unit = unitOf(words, index, found[2], known);
    for (const entry of entries) {
      if (entry.value !== value) continue;
      // An attached suffix that is no unit at all, as in `70th`, is not the entry's number either.
      if (unit && !entry.own.has(unit)) continue;
      if (!spansOf.get(entry).some((span) => near(index, span))) continue;
      problems.push({
        path: `${file}:${word.line}`,
        rule: "threshold-literal",
        detail: `'${word.norm}' restates the '${entry.key}' threshold (${entry.value}${entry.unit ? ` ${entry.unit}` : ""}); write {{${entry.prefix}:${entry.key}}}`,
      });
    }
  });
  return problems;
}

/** Paragraphs as word lists, each word with its line. A blank line ends a paragraph. */
function paragraphs(text) {
  const out = [];
  let words = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") {
      if (words.length > 0) out.push(words);
      words = [];
      return;
    }
    for (const [raw] of line.matchAll(/\S+/g)) {
      const norm = normal(raw);
      if (norm) words.push({ raw, norm, line: index + 1 });
    }
  });
  if (words.length > 0) out.push(words);
  return out;
}

/** The registries a check reads: the configured list, else the thresholds and the libraries. */
function registryList({ registries, thresholds, libraries }) {
  if (registries) return registries.map((registry) => ({ ...registry, prefixes: [registry.prefixes].flat() }));
  const source = { thresholds, libraries };
  return BUILT_IN.map(({ from, ...rest }) => ({ ...rest, entries: source[from] }));
}

const alternatives = (prefixes) => prefixes.map(escape).join("|");
const tokenPattern = (prefixes) => new RegExp(String.raw`\{\{(?:${alternatives(prefixes)}):[^}]*\}\}`, "g");
const annotationPattern = (prefixes) =>
  new RegExp(String.raw`(\S+)[ \t]*<!--\s*(${alternatives(prefixes)}):([\w.-]+)\s*-->`, "g");

/** What a word states, to compare with a figure: a number when the figure is one, else the word whole. */
function stated(word, value) {
  const found = NUMBER.exec(normal(word));
  if (typeof value !== "number") return normal(word);
  return found === null ? null : Number(found[1].replaceAll(",", ""));
}

/**
 * A number that carries its token, as in `70 <!-- q:coverage -->`, must equal the entry's figure.
 * The annotation and its number become one placeholder word, so no other scan sees them.
 */
function annotatedProblems(file, text, list, prefixes) {
  const owner = new Map(list.flatMap((registry) => registry.prefixes.map((prefix) => [prefix, registry])));
  const problems = [];
  const masked = text.replace(annotationPattern(prefixes), (whole, word, prefix, id, offset) => {
    const registry = owner.get(prefix);
    const at = `${file}:${text.slice(0, offset).split("\n").length}`;
    if (!Object.hasOwn(registry.entries, id)) {
      problems.push({ path: at, rule: "unknown-token", detail: `'${prefix}:${id}' names no entry of its registry` });
      return "TOKEN";
    }
    const valueKey = registry.valueKey ?? "value";
    const value = registry.entries[id]?.[valueKey];
    const figure = stated(word, value);
    if (value === undefined || value === null) {
      problems.push({ path: at, rule: "entry-without-value", detail: `the '${prefix}:${id}' entry has no '${valueKey}'` });
    } else if (figure === null) {
      problems.push({ path: at, rule: "annotation-without-number", detail: `'${prefix}:${id}' follows '${word}', which is no number` });
    } else if (figure !== value) {
      problems.push({
        path: at,
        rule: "stale-annotated-number",
        detail: `'${normal(word)}' is stale: the '${id}' entry is now ${value}; write ${value} <!-- ${prefix}:${id} --> or {{${prefix}:${id}}}`,
      });
    }
    return "TOKEN";
  });
  return { masked, problems };
}

function versionProblems(file, text, libraries) {
  const problems = [];
  for (const [id, library] of Object.entries(libraries)) {
    if (typeof library?.label !== "string" || library.label.trim() === "") continue;
    const label = escape(library.label.trim()).replace(/\s+/g, "\\s+");
    for (const found of text.matchAll(new RegExp(`(?<![\\w.])${label}\\s+v?\\d+(?:\\.\\d+)*\\b`, "gi"))) {
      const line = text.slice(0, found.index).split("\n").length;
      problems.push({
        path: `${file}:${line}`,
        rule: "version-literal",
        detail: `'${found[0].replace(/\s+/g, " ")}' restates the '${id}' version; write {{ver:${id}}} or {{v:${id}}}`,
      });
    }
  }
  return problems;
}

/**
 * @param {{path: string, contents: string}[]} docs  the markdown files, paths relative to the root
 * @param {{thresholds?: object, libraries?: object, exempt?: string[], registries?: object[]}} sources
 *   `thresholds` and `libraries` are the `gates` and the `libraries` of the two registries; `exempt` is the
 *   globs of files that may hold a figure. `registries` is a list of `{prefixes, entries, valueKey?, unitKey?}`
 *   that replaces the two as the source of tokens, annotations and phrases. `libraries` still feeds the label scan.
 */
export function checkRegistryLiteral(docs, { thresholds = {}, libraries = {}, exempt = [], registries }) {
  const list = registryList({ registries, thresholds, libraries });
  const prefixes = [...new Set(list.flatMap((registry) => registry.prefixes))];
  const token = tokenPattern(prefixes);
  const entries = list.flatMap(thresholdEntries);
  const known = new Set([...Object.values(UNIT_SPELLINGS).flat(), ...entries.flatMap((entry) => [...entry.own])]);
  const isExempt = globMatcher(exempt);
  const problems = [];
  for (const { path: file, contents } of docs) {
    if (isExempt(file)) continue;
    const annotated = annotatedProblems(file, contents.replace(/\r\n?/g, "\n"), list, prefixes);
    problems.push(...annotated.problems);
    // A placeholder word, so a token still counts as one word of the window.
    const text = annotated.masked.replace(token, "TOKEN");
    for (const words of paragraphs(text)) problems.push(...thresholdProblems(file, words, entries, known));
    problems.push(...versionProblems(file, text, libraries));
  }
  return problems;
}
