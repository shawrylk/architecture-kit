// A number a registry owns is written in the docs as a token, never as the figure. A figure goes
// stale the day the registry moves, and nothing else would notice.

import { escape } from "../eslint/options.mjs";
import { globMatcher } from "../glob.mjs";

const TOKEN = /\{\{(?:q|ver|v):[^}]*\}\}/g;
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
function thresholdEntries(thresholds) {
  return Object.entries(thresholds)
    .filter(([, entry]) => typeof entry.value === "number" && entry.match?.length > 0)
    .map(([key, entry]) => ({
      key,
      value: entry.value,
      unit: entry.unit,
      own: new Set(spellings(entry.unit)),
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
  const spansOf = new Map(entries.map((entry) => [entry.key, phraseSpans(words, entry.phrases)]));
  words.forEach((word, index) => {
    const found = NUMBER.exec(word.norm);
    if (found === null) return;
    const value = Number(found[1].replaceAll(",", ""));
    const unit = unitOf(words, index, found[2], known);
    for (const entry of entries) {
      if (entry.value !== value) continue;
      // An attached suffix that is no unit at all, as in `70th`, is not the entry's number either.
      if (unit && !entry.own.has(unit)) continue;
      if (!spansOf.get(entry.key).some((span) => near(index, span))) continue;
      problems.push({
        path: `${file}:${word.line}`,
        rule: "threshold-literal",
        detail: `'${word.raw}' restates the '${entry.key}' threshold (${entry.value}${entry.unit ? ` ${entry.unit}` : ""}); write {{q:${entry.key}}}`,
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
 * @param {{thresholds: object, libraries: object, exempt: string[]}} registries  the `gates` of the
 *   thresholds registry, the `libraries` of the versions registry, and the globs of files that may hold a figure
 */
export function checkRegistryLiteral(docs, { thresholds = {}, libraries = {}, exempt = [] }) {
  const entries = thresholdEntries(thresholds);
  const known = new Set([...Object.values(UNIT_SPELLINGS).flat(), ...entries.flatMap((entry) => [...entry.own])]);
  const isExempt = globMatcher(exempt);
  const problems = [];
  for (const { path: file, contents } of docs) {
    if (isExempt(file)) continue;
    // A placeholder word, so a token still counts as one word of the window.
    const text = contents.replace(/\r\n?/g, "\n").replace(TOKEN, "TOKEN");
    for (const words of paragraphs(text)) problems.push(...thresholdProblems(file, words, entries, known));
    problems.push(...versionProblems(file, text, libraries));
  }
  return problems;
}
