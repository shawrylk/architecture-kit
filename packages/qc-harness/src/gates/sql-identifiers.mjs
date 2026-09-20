// A resource slice writes hand-written SQL; a migration declares the columns it
// names. Nothing has ever run the two together, so a typo or a renamed column
// is invisible until deploy. This reads both and asserts they agree. QC-007.
//
// It proves names, not behaviour: that the policy applies, that a constraint
// fires, that a join is correct — none of that is in scope here.

// A column line is a name followed by anything; a constraint line opens with one
// of these words instead. Recognising constraints is robust where listing every
// type is not — a type this did not know once pushed a unit to pick another one.
const CONSTRAINT_OPENER = new Set(["primary", "unique", "check", "constraint", "foreign", "exclude", "like"]);
const COLUMN_LINE = /^([a-z_][a-z0-9_]*)\s+\S/;
const CREATE_TABLE = /create table (?:if not exists )?(\w+)\s*\(/g;
const ADD_COLUMN = /alter table (\w+)\s+add column (?:if not exists )?([a-z_]+)\s+/g;
const INDEX_NAME = /\bindex\("([a-z_]+)"\)/g;
// Columns are matched by shape — every column in this schema is snake_case.
const SNAKE = /\b([a-z][a-z0-9]*_[a-z0-9_]+)\b/g;
// Tables are matched by position instead. A single-word table name is
// indistinguishable from a keyword by shape, and a stop-list of keywords is the
// same trap as a list of column types: the one it misses blocks a unit.
const TABLE_POSITION = /\b(?:from|join|into|update)\s+([a-z][a-z0-9_]*)/g;
/** The few words that legally stand where a table would: `do update set`, `join lateral (`. */
const NOT_A_TABLE = new Set(["set", "lateral", "only", "select"]);
/** Names a statement binds for itself: a common table expression, or an alias. */
const LOCAL_BINDING = /(?:\bwith\s+(?:recursive\s+)?|,\s*)([a-z][a-z0-9_]*)\s+as\s*\(|\bas\s+([a-z][a-z0-9_]*)\b/g;

/** Functions and reserved names a statement may use that no table declares. */
export const SQL_BUILTINS = Object.freeze([
  "gen_random_uuid",
  "current_setting",
  "set_config",
  "pg_advisory_lock",
  "pg_advisory_unlock",
  "row_number",
  "string_agg",
  "array_agg",
  "jsonb_build_object",
  "to_jsonb",
  "date_trunc",
  "to_char",
  "to_timestamp",
  "generate_series",
  "array_position",
  "array_length",
  "char_length",
  "string_to_array",
  "jsonb_array_elements",
  "jsonb_set",
  "current_timestamp",
  "current_date",
]);

/** The text between the parenthesis at `open` and its match. */
function parens(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return source.slice(open + 1);
}

/** A constraint line declares no column, so only a name followed by a type counts. */
function addColumnLines(columns, body) {
  for (const line of body.split("\n")) {
    const column = COLUMN_LINE.exec(line.trim());
    if (column && !CONSTRAINT_OPENER.has(column[1])) columns.add(column[1]);
  }
}

/** @returns {Map<string, Set<string>>} table to its declared columns, across every migration. */
export function declaredColumns(sources) {
  const tables = new Map();
  for (const sql of sources) {
    CREATE_TABLE.lastIndex = 0;
    let match = CREATE_TABLE.exec(sql);
    while (match !== null) {
      const columns = tables.get(match[1]) ?? new Set();
      addColumnLines(columns, parens(sql, match.index + match[0].length - 1));
      tables.set(match[1], columns);
      match = CREATE_TABLE.exec(sql);
    }
    ADD_COLUMN.lastIndex = 0;
    let added = ADD_COLUMN.exec(sql);
    while (added !== null) {
      const columns = tables.get(added[1]) ?? new Set();
      columns.add(added[2]);
      tables.set(added[1], columns);
      added = ADD_COLUMN.exec(sql);
    }
  }
  return tables;
}

/**
 * Quoted literals are stripped first: a rank name inside a statement is a value,
 * not a column.
 *
 * A statement may be excused from the tenant predicate, but only out loud. The
 * marker sits directly above the statement, carries its reason, and is counted
 * and printed — an exemption is a thing a reviewer sees, not a thing a regex is
 * talked around. The one honest case so far is a share resolved by its secret,
 * where the tenant is what the lookup returns rather than what it filters on.
 */
const EXEMPT = /\/\/\s*tenant-predicate:\s*exempt\s*—\s*(.+)/;
// A migration file is `<sequence>_<slug>.sql`; the slug names the feature that owns it.
const MIGRATION_FILE = /^\d+_(.+)\.sql$/;

function statements(source) {
  const found = [];
  for (const match of source.matchAll(/`([^`]*)`/g)) {
    const body = match[1];
    if (!/\b(select|insert into|update|delete from)\b/i.test(body)) continue;
    const preamble = source.slice(Math.max(0, match.index - 400), match.index);
    const lastLines = preamble.split("\n").slice(-4).join("\n");
    found.push({
      sql: body.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""'),
      exemption: EXEMPT.exec(lastLines)?.[1]?.trim() ?? null,
    });
  }
  return found;
}

/** Names a statement binds for itself, so they are not references to a table. */
function boundIn(statement) {
  const bound = new Set();
  LOCAL_BINDING.lastIndex = 0;
  let binding = LOCAL_BINDING.exec(statement);
  while (binding !== null) {
    bound.add(binding[1] ?? binding[2]);
    binding = LOCAL_BINDING.exec(statement);
  }
  return bound;
}

/** Each statement a resource issues, with the names it binds for itself. */
export function sqlStatements(source) {
  return statements(source).map(({ sql, exemption }) => ({ sql, bound: boundIn(sql), exemption }));
}

/** Every name a resource's SQL leans on, split by how it was recognised. */
export function usedIdentifiers(source) {
  const used = new Set();
  const tables = new Set();
  const bound = new Set();
  for (const { sql: statement } of statements(source)) {
    for (const name of boundIn(statement)) bound.add(name);
    SNAKE.lastIndex = 0;
    let match = SNAKE.exec(statement);
    while (match !== null) {
      used.add(match[1]);
      match = SNAKE.exec(statement);
    }
    TABLE_POSITION.lastIndex = 0;
    let table = TABLE_POSITION.exec(statement);
    while (table !== null) {
      if (!NOT_A_TABLE.has(table[1])) tables.add(table[1]);
      table = TABLE_POSITION.exec(statement);
    }
  }
  for (const name of bound) {
    used.delete(name);
    tables.delete(name);
  }
  const declaredIndexes = new Set();
  INDEX_NAME.lastIndex = 0;
  let index = INDEX_NAME.exec(source);
  while (index !== null) {
    declaredIndexes.add(index[1]);
    index = INDEX_NAME.exec(source);
  }
  return { used, tables, declaredIndexes, bound };
}

/**
 * A migration is named for the feature that owns it, so the table it declares has
 * an owner. A feature reading another feature's table is the boundary rule broken
 * in SQL, where `qc/no-cross-feature-internals` cannot see it: there is no import
 * to flag. The answer is the other feature's published surface — ADR-0047.
 *
 * A feature may own more than one migration, so the slug is matched against the
 * features that exist rather than required to equal one: `0006_blueprints` and
 * `0006_blueprints_render_pages` both belong to `blueprints`. Requiring equality
 * once forced a unit to rename its file to get past this — the gate bent the
 * work instead of checking it.
 *
 * @param {{file: string, sql: string}[]} migrations
 * @param {Iterable<string>} [features] feature directory names, longest match wins
 * @returns {Map<string, string>} table to the feature whose migration declares it
 */
export function tableOwners(migrations, features = []) {
  const known = [...features].sort((a, b) => b.length - a.length);
  const owners = new Map();
  for (const { file, sql } of migrations) {
    const named = MIGRATION_FILE.exec(file);
    const slug = named ? named[1].replace(/_/g, "-") : file;
    const owner = known.find((feature) => slug === feature || slug.startsWith(`${feature}-`)) ?? slug;
    for (const table of declaredColumns([sql]).keys()) {
      owners.set(table, owner);
    }
  }
  return owners;
}

/**
 * @param {Map<string, Set<string>>} tables
 * @param {{path: string, source: string, feature?: string}[]} resources
 * @param {Map<string, string>} [owners]
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkSqlIdentifiers(tables, resources, owners = new Map()) {
  const known = new Set(SQL_BUILTINS);
  for (const [table, columns] of tables) {
    known.add(table);
    for (const column of columns) known.add(column);
  }
  const problems = [];
  for (const { path, source, feature } of resources) {
    const { used, tables: named, declaredIndexes } = usedIdentifiers(source);
    for (const identifier of [...new Set([...used, ...named])].sort()) {
      if (declaredIndexes.has(identifier)) continue;
      if (!known.has(identifier)) {
        problems.push({
          path,
          rule: "undeclared-sql-identifier",
          detail: `'${identifier}' is named in SQL but no migration declares it`,
        });
        continue;
      }
      const owner = owners.get(identifier);
      if (feature && owner && owner !== feature) {
        problems.push({
          path,
          rule: "cross-feature-table",
          detail: `'${identifier}' belongs to feature '${owner}'. Ask for its published surface, not its table`,
        });
      }
    }
  }
  return problems;
}
