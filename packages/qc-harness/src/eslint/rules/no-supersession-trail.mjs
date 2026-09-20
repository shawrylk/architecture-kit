// A change is rewritten in place, as if it had always been that way. No supersession
// trail, no deprecation note, no "what this replaces" — the repository states what is
// true now, and git holds the history. docs/decisions.md.
//
// Comments only. A vocabulary word in a string is someone's data, not this repository
// narrating its own past.

import { escape, optionsOf, schemaOf } from "../options.mjs";

const DEFAULT_PHRASES = [
  "deprecated",
  "deprecation",
  "superseded",
  "supersedes",
  "legacy",
  "this replaces",
  "replaced by",
  "formerly",
  "used to be",
  "no longer used",
  "kept for backwards compat",
  "backwards compatibility",
  "for backward compat",
  "old implementation",
];

export default {
  meta: {
    type: "problem",
    docs: { description: "no supersession trail in a comment; the repository states what is true now" },
    schema: schemaOf({ phrases: { type: "array", items: { type: "string" } } }),
    messages: {
      trail:
        "'{{phrase}}' narrates what this used to be. Rewrite in place and delete the trail — git holds the history.",
    },
  },
  create(context) {
    const phrases = optionsOf(context).phrases ?? DEFAULT_PHRASES;
    const pattern = new RegExp(`\\b(${phrases.map(escape).join("|")})\\b`, "i");
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const found = pattern.exec(comment.value);
          if (found !== null) {
            context.report({ node: comment, messageId: "trail", data: { phrase: found[1].toLowerCase() } });
          }
        }
      },
    };
  },
};
