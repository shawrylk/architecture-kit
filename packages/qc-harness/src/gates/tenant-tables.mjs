// Which tables row-level security must protect, read out of the feature that
// declares them. A feature owns its schema slice; no work order edits a shared
// policy file, so the policy file is generated. .claude/rules/swarm.md.

const DEFAULT_TABLE_FACTORY = "pgTable";
const DEFAULT_COLUMN = "tenantId";
const DEFAULT_SQL_COLUMN = "tenant_id";
const DEFAULT_SETTING = "app.tenant_id";
const DEFAULT_CAST = "uuid";

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


/** The text between the opening brace at `open` and its match. */
function block(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index);
    }
  }
  return source.slice(open);
}

/**
 * Every table in one resource slice that carries a tenant column. A table
 * without one is not listed: it is either not a business table, or it is a
 * finding for `qc/tenant-scoped-table`, and this file is not the place to say so.
 */
export function tenantScopedTables(source, options = {}) {
  const factory = escape(options.tableFactory ?? DEFAULT_TABLE_FACTORY);
  const tablePattern = new RegExp(`${factory}\\(\\s*"([a-z_][a-z0-9_]*)"\\s*,\\s*\\{`, "g");
  const column = new RegExp(`\\b${escape(options.column ?? DEFAULT_COLUMN)}\\b`);

  const found = new Set();
  let match = tablePattern.exec(source);
  while (match !== null) {
    const body = block(source, match.index + match[0].length - 1);
    if (column.test(body)) found.add(match[1]);
    match = tablePattern.exec(source);
  }
  return [...found].sort();
}

/** The same predicate for every table, so a table added later is two more lines. */
export function policyStatements(table, options = {}) {
  const sqlColumn = options.sqlColumn ?? DEFAULT_SQL_COLUMN;
  const setting = options.setting ?? DEFAULT_SETTING;
  const cast = options.cast ?? DEFAULT_CAST;
  const predicate = `${sqlColumn} = current_setting('${setting}')::${cast}`;
  return [
    `alter table ${table} enable row level security;`,
    `alter table ${table} force row level security;`,
    "",
    `drop policy if exists ${table}_isolation on ${table};`,
    `create policy ${table}_isolation on ${table}`,
    `  using (${predicate})`,
    `  with check (${predicate});`,
  ].join("\n");
}
