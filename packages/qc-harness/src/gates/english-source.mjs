// Comments, docs and rules are written in English. The repository's domain is Japanese, so the
// rule cannot be "no Japanese in the tree" -- an official standard's title, a prompt that reads a
// Japanese drawing and the user-facing dictionary are all data, and translating them breaks them.
//
// The line is prose against data. Prose a developer writes for another developer is English. Data
// the product needs in another language is declared, and its English variant must exist beside it.

const SCRIPTS = {
  // Hiragana, katakana, CJK ideographs, Hangul: language a reader must know to follow the text.
  cjk: "\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af",
  // Fullwidth forms are typography, not language -- `（{count}）` costs an English reader nothing.
  // Separate, so a repository that wants ASCII punctuation can ask for it without conflating the two.
  fullwidth: "\\uff00-\\uffef",
};

function scriptPattern(scripts) {
  const ranges = scripts.map((name) => SCRIPTS[name] ?? name).join("");
  if (ranges === "") throw new Error("language.scripts must name at least one script range");
  return new RegExp(`[${ranges}]`);
}

function globToRegExp(glob) {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${body}$`);
}

export function matchesAny(relPath, globs) {
  return globs.some((glob) => globToRegExp(glob).test(relPath));
}

/**
 * Splits a source file's lines into the ones that are comment prose and the ones that are not.
 * A heuristic, deliberately: it never needs to be exact, because a string that trips the comment
 * rule is still a string that has to be declared.
 */
export function commentLines(contents, lineComment = ["//", "#", "--"]) {
  const out = [];
  let inBlock = false;
  contents.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    const opensBlock = trimmed.startsWith("/*");
    const isComment =
      inBlock || opensBlock || trimmed.startsWith("*") || lineComment.some((token) => trimmed.startsWith(token));
    if (opensBlock && !trimmed.includes("*/")) inBlock = true;
    else if (inBlock && trimmed.includes("*/")) inBlock = false;
    if (isComment) out.push({ line: index + 1, text: line });
  });
  return out;
}

/**
 * @param {{path: string, contents: string}[]} files paths relative to the repository root
 * @param {{scripts?: string[], allowNonEnglish?: string[], translationPairs?: {pattern: string, english: string}[]}} [options]
 */
export function checkEnglishSource(files, options = {}) {
  const script = scriptPattern(options.scripts ?? ["cjk"]);
  // `legacyNonEnglish` names individual files that predate the rule. It is kept apart from
  // `allowNonEnglish` so the debt stays countable, and an entry that no longer needs to be there
  // fails -- which is what makes the list shrink instead of ossify.
  const legacy = options.legacyNonEnglish ?? [];
  const allowed = [...(options.allowNonEnglish ?? []), ...legacy];
  const used = new Set();
  const problems = [];

  for (const { path, contents } of files) {
    if (!script.test(contents)) continue;
    const declared = matchesAny(path, allowed);

    // In Markdown every line is prose, and `#` opens a heading rather than a comment. Running the
    // code heuristic over a document reports its headings as comments, so the file-level rule --
    // is this document declared -- is the only one that applies.
    const prose = path.endsWith(".md") ? [] : commentLines(contents);
    for (const { line, text } of prose) {
      if (!script.test(text)) continue;
      problems.push({
        path,
        rule: "english-comment",
        detail: `line ${line}: a comment is written in English. Name the term in English, or cite the glossary entry for it.`,
      });
    }
    if (declared && legacy.includes(path)) used.add(path);
    if (!declared && !problems.some((problem) => problem.path === path)) {
      problems.push({
        path,
        rule: "english-source",
        detail:
          "carries non-English text that is not declared. Data the product needs in another " +
          "language belongs in a path listed under language.allowNonEnglish, beside its English variant.",
      });
    }
  }
  for (const path of legacy) {
    if (!used.has(path)) {
      problems.push({
        path,
        rule: "stale-legacy-entry",
        detail: "listed under language.legacyNonEnglish but carries no non-English text. Delete the entry.",
      });
    }
  }
  return problems;
}

/**
 * Every declared translation has an English variant beside it, so English is the one language
 * present in every set -- the main variant, whatever else a repository adds.
 * @param {string[]} paths every file in the repository, relative to its root
 */
export function checkTranslationPairs(paths, pairs = []) {
  const problems = [];
  for (const { pattern, english } of pairs) {
    for (const path of paths.filter((candidate) => matchesAny(candidate, [pattern]))) {
      const beside = path.replace(/[^/]+$/, english);
      if (beside === path) continue;
      if (!paths.includes(beside)) {
        problems.push({
          path,
          rule: "english-variant-missing",
          detail: `a translation without its English variant. Add ${beside}: every language set carries English.`,
        });
      }
    }
  }
  return problems;
}
