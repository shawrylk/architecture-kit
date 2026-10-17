// Finding a component before writing one: rank the catalog entries by the tokens they share with the
// words asked. The camel-case parts of a name weigh most, then its description and its prop names.

const FILLER = new Set(["a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "with", "is", "it", "this", "that"]);
const NAME_WEIGHT = 3;

const singular = (token) => (token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token);

/** Lowercase tokens: camel-case parts, digit runs and words, with filler dropped and a trailing plural s removed. */
export function tokensOf(text) {
  const parts = String(text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return parts.filter((token) => !FILLER.has(token)).map(singular);
}

/**
 * @param {{name: string, path: string, props: string[], description: string}[]} entries
 * @param {string[]} words what the caller wants, in any case
 * @param {number} [limit]
 * @returns {{entry: object, score: number}[]} the best first; an entry that shares no token is left out
 */
export function findComponents(entries, words, limit = 8) {
  const wanted = new Set(words.flatMap(tokensOf));
  if (wanted.size === 0) return [];
  const count = (tokens) => [...new Set(tokens)].filter((token) => wanted.has(token)).length;
  const scored = entries.map((entry) => ({
    entry,
    score:
      NAME_WEIGHT * count(tokensOf(entry.name)) + count(tokensOf(entry.description)) + count(entry.props.flatMap(tokensOf)),
  }));
  return scored
    .filter((one) => one.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name) || a.entry.path.localeCompare(b.entry.path))
    .slice(0, limit);
}

/** One line per entry: `name — path — description`. */
export function formatFound({ entry }) {
  return `${entry.name} — ${entry.path} — ${entry.description}`;
}
