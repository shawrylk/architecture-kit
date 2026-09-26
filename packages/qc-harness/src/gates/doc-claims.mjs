// A true claim in a document can go stale and still read as current. A fenced state-claim
// block pairs a file with its line count, so the claim is checked instead of trusted.

const CLAIM_BLOCK = /```state-claim\r?\n([\s\S]*?)```/g;

/** @returns {{file: string, lines: number}[]} each block that names both a file and a count */
export function parseDocClaims(contents) {
  const claims = [];
  for (const [, block] of contents.matchAll(CLAIM_BLOCK)) {
    const file = /file:\s*(\S+)/.exec(block)?.[1];
    const lines = /lines:\s*(\d+)/.exec(block)?.[1];
    if (file && lines) claims.push({ file, lines: Number(lines) });
  }
  return claims;
}

/** Newline-terminated lines, as `wc -l` counts them, with CRLF read as LF. */
export function lineCount(contents) {
  const normalized = contents.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n");
  return normalized.endsWith("\n") ? parts.length - 1 : parts.length;
}

/**
 * @param {string} doc the document that makes the claims
 * @param {{file: string, lines: number}[]} claims
 * @param {Map<string, string | null>} targets each claimed file's contents, null when it is missing
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkDocClaims(doc, claims, targets) {
  const problems = [];
  for (const claim of claims) {
    const contents = targets.get(claim.file) ?? null;
    const actual = contents === null ? null : lineCount(contents);
    if (actual === claim.lines) continue;
    problems.push({
      path: claim.file,
      rule: "stale-doc-claim",
      detail: actual === null
        ? `${doc} claims ${claim.lines} lines; the file no longer exists`
        : `${doc} claims ${claim.lines} lines; the file now has ${actual}`,
    });
  }
  return problems;
}
