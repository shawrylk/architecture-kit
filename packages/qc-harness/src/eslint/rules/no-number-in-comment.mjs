// A number in a comment is maintenance work that buys nothing. docs/enforcement.md.
// Citation identifiers are the exception — citing instead of restating is the point.

import { escape, optionsOf, schemaOf } from "../options.mjs";

// Decision ids this repository defines. A prefix, then a number.
const DEFAULT_PREFIXES = ["ADR", "QC"];
// Ids a repository cites but does not own.
const DEFAULT_EXTERNAL = ["REQ-[A-Z]{3}-\\d+", "T\\d+-\\d+", "D\\d+"];
// Standards and encodings are identifiers everywhere, not thresholds.
const STANDARDS = [
  "WCAG(?: \\d(?:\\.\\d)*)?",
  "ES\\d{4}",
  "UTF-8",
  "SHA-256",
  "HTTP\\/\\d",
  "RFC \\d+",
  "base64",
  "utf8",
  "\\d+_[a-z0-9_]+",
];

const DIGIT = /\d/;

const NUMBER_WORDS =
  "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand";
const QUANTITY_UNITS =
  "times|seconds?|mins?|minutes?|hours?|days?|ms|milliseconds?|bytes?|kb|mb|gb|retries|attempts?";
const THRESHOLD_PREFIXES =
  "wait|sleep|delay|budget|quota|timeout|at most|up to|batch of|limit of|maximum of";

const QUANTITY_WORD = new RegExp(
  `\\b(?:${NUMBER_WORDS})\\s+(?:${QUANTITY_UNITS})\\b|\\b(?:${THRESHOLD_PREFIXES})\\s+(?:${NUMBER_WORDS})\\b`,
  "i",
);

function citationPattern({ prefixes, external, standards }) {
  const alternatives = [
    ...prefixes.map((prefix) => `${escape(prefix)}-\\d+`),
    ...external,
    ...standards,
  ];
  return new RegExp(`\\b(?:${alternatives.join("|")})\\b`);
}

export default {
  meta: {
    type: "problem",
    docs: { description: "no numeric literal or quantity threshold in a comment; cite the registry instead" },
    schema: schemaOf({
      prefixes: { type: "array", items: { type: "string" } },
      external: { type: "array", items: { type: "string" } },
      standards: { type: "array", items: { type: "string" } },
      registry: { type: "string" },
    }),
    messages: {
      number: "Number or quantity threshold in a comment. Cite {{registry}} or the doc that owns it.",
    },
  },
  create(context) {
    const options = optionsOf(context);
    const citation = citationPattern({
      prefixes: options.prefixes ?? DEFAULT_PREFIXES,
      external: options.external ?? DEFAULT_EXTERNAL,
      standards: options.standards ?? STANDARDS,
    });
    const registry = options.registry ?? "the decision registry";

    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          // Strip citations, then anything left with a digit is a literal.
          let stripped = comment.value;
          let match;
          while ((match = citation.exec(stripped)) !== null) {
            stripped = stripped.replace(match[0], "");
          }
          // Backtick-quoted code is a reference, never a prose quantity claim.
          stripped = stripped.replace(/`[^`]*`/g, "");
          // A lone list marker or an identifier-embedded digit is not a threshold.
          stripped = stripped.replace(/\b[a-zA-Z_$][\w$]*\d[\w$]*\b/g, "");
          if (DIGIT.test(stripped) || QUANTITY_WORD.test(stripped)) {
            context.report({ node: comment, messageId: "number", data: { registry } });
          }
        }
      },
    };
  },
};
