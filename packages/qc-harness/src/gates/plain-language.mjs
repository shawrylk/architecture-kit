// Prose a person reads is written in Simplified Technical English (ASD-STE100), in the Google
// developer documentation style. The approved dictionary is licensed and needs a part-of-speech
// tagger, so this gate carries the part a regular expression can prove: sentence and paragraph
// length, the voice, the words this repository replaced, and the heading and link forms.
//
// The rest of the standard -- approved meaning, approved part of speech, noun clusters -- stays a
// review rule. A gate that guesses at grammar teaches a writer to fight the gate.

import { commentLines, matchesAny } from "./english-source.mjs";

// Left is what a writer reaches for; right is the word that costs a reader less. An empty string
// means the word carries nothing and comes out. A repository adds its own under
// plainLanguage.replace, and removes one the kit ships by setting its value to null.
export const DEFAULT_REPLACE = Object.freeze({
  // A longer word for a shorter act.
  utilize: "use",
  utilise: "use",
  leverage: "use",
  facilitate: "help",
  commence: "start",
  initiate: "start",
  terminate: "stop",
  demonstrate: "show",
  endeavour: "try",
  endeavor: "try",
  ascertain: "find out",
  obtain: "get",
  purchase: "buy",
  assist: "help",
  attempt: "try",
  provide: "give",
  require: "need",
  sufficient: "enough",
  additional: "more",
  approximately: "about",
  subsequent: "later",
  prior: "earlier",
  methodology: "method",
  functionality: "the function",
  component: "part",
  granular: "detailed",
  paradigm: "model",
  cognizant: "aware",
  aforementioned: "this",
  myriad: "many",
  plethora: "many",
  orchestrate: "run",
  architected: "designed",
  delve: "look at",
  // Words that read as measurement and are opinion.
  robust: "",
  seamless: "",
  seamlessly: "",
  holistic: "",
  elegant: "",
  powerful: "",
  comprehensive: "",
  "cutting-edge": "",
  "state-of-the-art": "",
  // Words that tell the reader how to feel about the work.
  simply: "",
  just: "",
  easily: "",
  easy: "",
  obviously: "",
  clearly: "",
  basically: "",
  actually: "",
  please: "",
  // More words than the sentence needs.
  "in order to": "to",
  "so as to": "to",
  "due to the fact that": "because",
  "in the event that": "if",
  "in the event of": "if",
  "at this point in time": "now",
  "at this time": "now",
  "a number of": "some",
  "the majority of": "most",
  "is able to": "can",
  "are able to": "can",
  "has the ability to": "can",
  "have the ability to": "can",
  "make use of": "use",
  "perform a check": "check",
  "in terms of": "for",
  "with regard to": "about",
  "with respect to": "about",
  "prior to": "before",
  "subsequent to": "after",
  "it is worth noting that": "",
  "it should be noted that": "",
  "note that": "",
  "allows you to": "lets you",
  "in a timely manner": "on time",
  // Latin a reader translates before they read.
  "e.g.": "for example",
  "i.e.": "that is",
  "etc.": "and so on",
  "vs.": "compared with",
  "n.b.": "note",
  "ad hoc": "unplanned",
  via: "through",
  // One meaning per word: these carry two.
  should: "must, or can",
  may: "can, or is permitted to",
  might: "can",
  once: "after",
  since: "because, or after",
  while: "at the same time as, or although",
  // Violence and disability as metaphor, which the Google style guide removes.
  "sanity check": "quick check",
  "sanity-check": "quick check",
  "dummy value": "placeholder value",
  blacklist: "denylist",
  whitelist: "allowlist",
  "master branch": "main branch",
  cripple: "slow down",
  crippled: "slowed down",
  // Metaphor where a plain word exists.
  "deep dive": "detailed look",
  unpack: "explain",
  ecosystem: "the set of tools",
  journey: "sequence of steps",
  "under the hood": "inside",
  "out of the box": "with no setup",
});

// Skipped by the heading rule: a name is capitalised wherever it stands. All-capital words, words
// carrying a digit, and words carrying a dot or a slash are read as identifiers and skipped too.
export const DEFAULT_PROPER_NOUNS = Object.freeze([
  "Anthropic", "Claude", "Docker", "Git", "GitHub", "GitLab", "Google", "JavaScript", "Kubernetes",
  "Linux", "Markdown", "Node", "Postgres", "PostgreSQL", "Python", "React", "Simplified",
  "Technical", "English", "TypeScript", "Windows", "macOS", "Terraform", "Drizzle", "Fastify",
]);

const DEFAULTS = {
  maxInstructionWords: 20,
  maxDescriptiveWords: 25,
  maxParagraphSentences: 6,
  passive: true,
  headings: true,
  links: true,
  punctuation: true,
};

// A form of "to be" and a past participle, which is the shape a reader has to turn round to find
// the actor. The generic tail is `-ed` only: an `-en` pattern reads "often" and "even" as verbs.
const BE = "(?:am|is|are|was|were|be|been|being|gets|got)";
const IRREGULAR =
  "built|done|made|sent|set|put|kept|held|read|run|lost|left|found|told|brought|caught|taught|" +
  "thought|bought|dealt|meant|met|paid|said|sold|felt|written|given|taken|seen|known|shown|driven|" +
  "drawn|chosen|broken|spoken|hidden|frozen|forgotten";
// `un-` is dropped from the generic tail: "is uncommitted" and "is unchanged" are states a
// reader already reads as states, and flagging them teaches nobody to name an actor.
const PASSIVE = new RegExp(`\\b${BE}\\s+(?:(?!un)\\w{3,}ed|${IRREGULAR})\\b`, "i");

// A dash and a semicolon are where two sentences hide inside one. Both are a full stop that a
// writer did not take, and both are what makes a paragraph need a second reading.
const EM_DASH = /\u2014|\s--\s/;
const SEMICOLON = /;/;

const VAGUE_LINK = /\[\s*(?:here|this|link|more|read more|learn more|click here|this link|this page)\s*\]\(/i;

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A word list becomes one matcher per entry, so a phrase and a word are found the same way. */
function wordMatchers(replace) {
  return Object.entries(replace)
    .filter(([, better]) => typeof better === "string")
    .map(([word, better]) => ({
      word,
      better,
      pattern: new RegExp(`(?<![\\w-])${escape(word)}(?![\\w-])`, "i"),
    }));
}

/**
 * Removes what is not prose from a line: code spans, link targets, bare URLs and HTML. A reader
 * does not read these as sentences, and a path counts as neither a word nor a capital letter.
 */
export function stripInline(text) {
  return text
    .replace(/`[^`]*`/g, " ")
    .replace(/\]\([^)]*\)/g, "] ")
    .replace(/<[^>\s]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
}

/** Splits on a stop that a capital follows, so `config.json is read` stays one sentence. */
export function sentences(text) {
  return text
    .split(/(?<=[.!?])["')\]]?\s+(?=[A-Z"'(\[])/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function wordCount(text) {
  return text.split(/\s+/).filter((word) => /[A-Za-z0-9]/.test(word)).length;
}

/**
 * A document's prose, in blocks. A hard-wrapped paragraph is one block, not one block a line:
 * a sentence a writer broke over two lines is still one sentence to the reader.
 *
 * A fence, a table, a front matter block, a quote and an indented block are not prose. Reporting
 * a sentence inside one teaches a writer to break the fence instead.
 * @returns {{line: number, text: string, kind: "heading"|"item"|"text"}[]}
 */
export function markdownProse(contents) {
  const out = [];
  let fence = null;
  let front = false;
  let open = null;

  const flush = () => {
    if (open !== null) out.push({ line: open.line, text: open.parts.join(" "), kind: open.kind });
    open = null;
  };

  contents.split("\n").forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (index === 0 && trimmed === "---") {
      front = true;
      return;
    }
    if (front) {
      if (trimmed === "---") front = false;
      return;
    }
    const opener = /^(```+|~~~+)/.exec(trimmed);
    if (fence !== null) {
      if (opener !== null && opener[1][0] === fence[0]) fence = null;
      return;
    }
    if (opener !== null) {
      flush();
      fence = opener[1];
      return;
    }
    const skipped =
      trimmed === "" ||
      trimmed.startsWith("|") ||
      trimmed.startsWith(">") ||
      trimmed.startsWith("<!--") ||
      /^(?: {4,}|\t)/.test(raw) ||
      /^([-*_])\s*(?:\1\s*){2,}$/.test(trimmed);
    if (skipped) {
      flush();
      return;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    if (heading !== null) {
      flush();
      out.push({ line, text: heading[1], kind: "heading" });
      return;
    }
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(trimmed);
    if (item !== null) {
      flush();
      open = { line, parts: [item[1]], kind: "item" };
      return;
    }
    if (open === null) open = { line, parts: [], kind: "text" };
    open.parts.push(trimmed);
  });
  flush();
  return out;
}

/** A source file's prose is its comments, read with the same heuristic the language gate uses. */
function commentProse(contents) {
  return commentLines(contents).map(({ line, text }) => ({
    line,
    text: text.trim().replace(/^(?:\/\/+|#+|--+|\/\*+|\*+\/?)\s*/, "").replace(/\*\/\s*$/, "").trim(),
    kind: "text",
  }));
}

function headingProblems(text, proper) {
  const words = stripInline(text)
    .split(/\s+/)
    .filter((word) => word !== "")
    // A numbered heading carries its number as a token. The word after it is the first word.
    .filter((word, index) => !(index === 0 && /^\d+[.)]?$/.test(word)));
  return words.slice(1).filter((raw) => {
    const word = raw.replace(/^[("'\[]+|[)"'\],.:;!?]+$/g, "");
    if (!/^[A-Z][a-z]/.test(word)) return false;
    if (/[\d./\\_]/.test(word)) return false;
    return !proper.has(word);
  });
}

/**
 * @param {{path: string, contents: string}[]} files paths relative to the repository root
 * @param {object} [options] see `plainLanguage` in the kit's config defaults
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkPlainLanguage(files, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const matchers = wordMatchers({ ...DEFAULT_REPLACE, ...(options.replace ?? {}) });
  const proper = new Set([...DEFAULT_PROPER_NOUNS, ...(options.properNouns ?? [])]);
  const allow = options.allow ?? [];
  const problems = [];

  for (const { path, contents } of files) {
    if (matchesAny(path, allow)) continue;
    const units = path.endsWith(".md") ? markdownProse(contents) : commentProse(contents);
    for (const unit of units) {
      const prose = stripInline(unit.text);
      const parts = sentences(prose);
      const limit = unit.kind === "item" ? config.maxInstructionWords : config.maxDescriptiveWords;

      if (unit.kind === "text" && parts.length > config.maxParagraphSentences) {
        problems.push({
          path,
          rule: "paragraph-too-long",
          detail: `line ${unit.line}: ${parts.length} sentences, max ${config.maxParagraphSentences}. Split it, or make it a list.`,
        });
      }

      if (unit.kind !== "heading") {
        for (const part of parts) {
          const words = wordCount(part);
          if (words > limit) {
            const kind = unit.kind === "item" ? "an instruction" : "a description";
            problems.push({
              path,
              rule: "sentence-too-long",
              detail: `line ${unit.line}: ${words} words in ${kind}, max ${limit}. One idea per sentence.`,
            });
          }
          if (config.passive && PASSIVE.test(part)) {
            problems.push({
              path,
              rule: "passive-voice",
              detail: `line ${unit.line}: "${PASSIVE.exec(part)[0]}" is passive. Name who acts, then the act.`,
            });
          }
        }
      }

      for (const { word, better, pattern } of matchers) {
        if (!pattern.test(prose)) continue;
        problems.push({
          path,
          rule: "unapproved-word",
          detail:
            better === ""
              ? `line ${unit.line}: "${word}" carries nothing a reader needs. Delete it.`
              : `line ${unit.line}: "${word}" is not the approved word. Write "${better}".`,
        });
      }

      if (config.headings && unit.kind === "heading") {
        const capitals = headingProblems(unit.text, proper);
        if (capitals.length > 0) {
          problems.push({
            path,
            rule: "heading-case",
            detail: `line ${unit.line}: a heading is sentence case. Lowercase ${capitals.map((word) => `"${word}"`).join(", ")}.`,
          });
        }
      }

      if (config.punctuation) {
        if (EM_DASH.test(prose)) {
          problems.push({
            path,
            rule: "em-dash",
            detail: `line ${unit.line}: a dash holds two sentences in one. Use a full stop, a comma or a colon.`,
          });
        }
        if (SEMICOLON.test(prose)) {
          problems.push({
            path,
            rule: "semicolon",
            detail: `line ${unit.line}: a semicolon joins two sentences. Write two sentences.`,
          });
        }
      }

      if (config.links && VAGUE_LINK.test(unit.text)) {
        problems.push({
          path,
          rule: "link-text",
          detail: `line ${unit.line}: link text says where to click, not what is there. Name the page.`,
        });
      }
    }
  }
  return problems;
}
