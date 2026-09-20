// A named pattern is a pointer, not a lesson. Naming it costs an agent a few tokens and a human a
// web search; re-teaching it costs every reader of this file, every time it is loaded.

import { optionsOf, schemaOf } from "../options.mjs";

const DEFAULT_MAX_WORDS = 20;

// Canonical names a reader can look up. A repository adds its own through `patterns`.
const DEFAULT_PATTERNS = [
  "outbox",
  "saga",
  "circuit breaker",
  "bulkhead",
  "backpressure",
  "keyset pagination",
  "cursor pagination",
  "cqrs",
  "event sourcing",
  "unit of work",
  "repository pattern",
  "anti-corruption layer",
  "hexagonal",
  "adapter pattern",
  "strategy pattern",
  "observer pattern",
  "builder pattern",
  "factory pattern",
  "singleton",
  "memoization",
  "debounce",
  "throttle",
  "exponential backoff",
  "token bucket",
  "leaky bucket",
  "idempotency key",
  "optimistic locking",
  "pessimistic locking",
  "last-write-wins",
  "crdt",
  "two-phase commit",
  "write-ahead log",
  "copy-on-write",
  "dependency injection",
  "inversion of control",
  "fan-out",
  "dead-letter queue",
  "content-addressed",
  "bloom filter",
  "trie",
  "lru",
];

function proseOf(comment) {
  return comment.value
    .split("\n")
    .map((line) => line.replace(/^\s*\*+\s?/, "").trim())
    .filter((line) => line !== "" && !line.startsWith("@"))
    .join(" ");
}

// Mentioning a pattern while saying what a file does is not teaching it. The finding needs a
// definitional turn after the name -- the shape an explanation takes and a description does not.
const EXPLAINS = /\b(?:is|are|works? by|means|refers to|consists of|guarantees?|ensures?|in other words|that is|lets you|allows)\b/i;

export function namedPattern(prose, patterns) {
  const haystack = prose.toLowerCase();
  for (const name of patterns) {
    const at = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).exec(haystack);
    if (at && EXPLAINS.test(haystack.slice(at.index + name.length))) return name;
  }
  return undefined;
}

export function wordsOf(prose) {
  return prose.split(/\s+/).filter(Boolean).length;
}

export default {
  meta: {
    type: "suggestion",
    docs: { description: "a comment names a standard pattern and stops, it never re-teaches one" },
    schema: schemaOf({
      maxWords: { type: "integer", minimum: 3 },
      patterns: { type: "array", items: { type: "string" } },
      extra: { type: "array", items: { type: "string" } },
    }),
    messages: {
      explained:
        "Comment explains the {{pattern}} pattern in {{words}} words. Name it and stop — " +
        "a reader looks it up, and every agent that loads this file pays for the lesson.",
    },
  },
  create(context) {
    const options = optionsOf(context);
    const maxWords = options.maxWords ?? DEFAULT_MAX_WORDS;
    // `patterns` replaces the vocabulary; `extra` adds a repository's own names to it.
    const patterns = [...(options.patterns ?? DEFAULT_PATTERNS), ...(options.extra ?? [])];

    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const prose = proseOf(comment);
          const words = wordsOf(prose);
          if (words <= maxWords) continue;
          const pattern = namedPattern(prose, patterns);
          if (pattern) context.report({ node: comment, messageId: "explained", data: { pattern, words } });
        }
      },
    };
  },
};
