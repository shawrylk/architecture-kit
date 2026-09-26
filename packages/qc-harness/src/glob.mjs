// A fragment: the one glob matcher. The work-order guard, the English gate and the file lister
// all read globs from qc.config.json, so they must agree on what a glob matches.

/** `**` crosses folders and `*` stays inside one. Every other character is literal. */
export function globToRegExp(glob) {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${body}$`);
}

/**
 * A matcher for a list of globs over repository-relative paths. A leading `**` also matches at the
 * root, as ESLint reads the same globs: `**\/*.generated.*` matches `a.generated.ts` and `src/a.generated.ts`.
 * @param {readonly string[]} globs
 * @returns {(rel: string) => boolean}
 */
export function globMatcher(globs) {
  const patterns = globs.map(globToRegExp);
  return (rel) => patterns.some((pattern) => pattern.test(rel) || pattern.test(`/${rel}`));
}
