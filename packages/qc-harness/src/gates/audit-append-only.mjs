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
  const name = escape(table);
  // The table in a mutating position. An insert naming it is the whole point.
  const mutation = new RegExp(`\\b(?:update\\s+${name}\\b|delete\\s+from\\s+${name}\\b|truncate\\s+(?:table\\s+)?${name}\\b)`, "i");
  const problems = [];
  for (const { path, statements } of resources) {
    for (const { sql } of statements) {
      const found = mutation.exec(sql);
      if (found !== null) {
        problems.push({
          path,
          rule: "audit-mutated",
          detail: `'${found[0].trim()}' — ${table} is append-only, so no repository may hold an update or delete path for it`,
        });
      }
    }
  }
  return problems;
}
