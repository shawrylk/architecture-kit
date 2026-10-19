// The audit log is append-only: no update or delete path exists in any repository.
// A log a writer can edit is not evidence of anything. docs/architecture.md.

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const DEFAULT_TABLE = "audit_log";

/**
 * @param {{path: string, statements: {sql: string}[]}[]} resources  as sqlStatements reads them
 * @param {{table?: string}} [options]
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkAuditAppendOnly(resources, options = {}) {
  const table = options.table ?? DEFAULT_TABLE;
  // The table as SQL can name it: quoted or not, under a schema or not, after `only` or not.
  const name = table.split(".").map((part) => `"?${escape(part)}"?`).join("\\s*\\.\\s*");
  const ref = `(?:only\\s+)?(?:(?:"[^"]+"|\\w+)\\s*\\.\\s*)?${name}(?![\\w$"])`;
  // The table in a mutating position. An insert naming it is the whole point, but an upsert rewrites a row.
  const mutation = new RegExp(
    [
      `update\\s+${ref}`,
      `delete\\s+from\\s+${ref}`,
      `truncate\\s+(?:table\\s+)?(?:only\\s+)?(?:[\\w."]+\\s*,\\s*)*${ref}`,
      `merge\\s+into\\s+${ref}`,
      `insert\\s+into\\s+${ref}[^;]*?\\bon\\s+conflict\\b[^;]*?\\bdo\\s+update\\b`,
    ]
      .map((form) => `\\b${form}`)
      .join("|"),
    "i",
  );
  const problems = [];
  for (const { path, statements } of resources) {
    for (const { sql } of statements) {
      const found = mutation.exec(sql);
      if (found !== null) {
        const quoted = found[0].replace(/\s+/g, " ").trim();
        problems.push({
          path,
          rule: "audit-mutated",
          detail: `'${quoted.length > 60 ? `${quoted.slice(0, 57)}...` : quoted}' — ${table} is append-only, so no repository may hold an update or delete path for it`,
        });
      }
    }
  }
  return problems;
}
