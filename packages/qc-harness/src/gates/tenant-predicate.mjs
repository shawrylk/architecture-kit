// Tenant isolation is the security model, and its first leg is the repository
// predicate: every statement that touches a business table names the tenant.
// Each feature proves its own with a two-tenant test; this proves all of them at
// once, and proves it for the statement nobody wrote a test for.
// docs/architecture.md, .claude/rules/security.md.
//
// It reads the predicate, not the value. That a predicate is present is
// structural; that it is correct is what the two-tenant test is for.

const DEFAULT_TENANT_COLUMN = "tenant_id";
const DEFAULT_INSERT_HELPER = "insertReturning";

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Naming the column is not scoping by it: a select list mentioning the tenant
// column reads every tenant's rows just as happily. The predicate is what counts.
function scopedPattern(column) {
  return new RegExp(`\\b${escape(column)}\\s*=`);
}
// Nine of eleven features write their generic helpers with the table name as a
// runtime value — `from ${table}`. Matching only literal names skipped those
// statements silently, which is worse than failing: the check reported OK while
// looking at nothing. A statement on a table named at runtime is still a
// statement on a business table, and still has to carry the tenant.
const DYNAMIC_TABLE = /\b(?:from|join|into|update)\s+\$\{/;

/** True when the statement actually filters or writes the tenant, not merely names it. */
function scopedBy(sql, column) {
  if (scopedPattern(column).test(sql)) return true;
  const inserted = /insert\s+into\s+(?:\w+|\$\{[^}]*\})\s*\(([^)]*)\)/i.exec(sql);
  return inserted ? new RegExp(`\\b${escape(column)}\\b`).test(inserted[1]) : false;
}

/** A statement that reads only a bound name touches no table and needs no predicate. */
function namesOwnedTable(statement, owned, bound) {
  for (const table of owned) {
    const pattern = new RegExp(`\\b(?:from|join|into|update)\\s+${table}\\b`);
    if (pattern.test(statement) && !bound.has(table)) return table;
  }
  return null;
}

/**
 * @param {{path: string, statements: {sql: string, bound: Set<string>}[]}[]} resources
 * @param {Set<string>} owned every business table any migration declares
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkTenantPredicate(resources, owned, options = {}) {
  const column = options.column ?? DEFAULT_TENANT_COLUMN;
  const problems = [];
  for (const { path, statements } of resources) {
    for (const { sql, bound, exemption } of statements) {
      const table = namesOwnedTable(sql, owned, bound) ?? (DYNAMIC_TABLE.test(sql) ? "a table named at runtime" : null);
      if (!table) continue;
      if (exemption) continue;
      if (scopedBy(sql, column)) continue;
      problems.push({
        path,
        rule: "unscoped-statement",
        detail: `a statement on '${table}' does not filter on ${column}. Carry the tenant, or mark the statement exempt with its reason`,
      });
    }
  }
  return problems;
}

// Adopting the shared `insertReturning` moved the statement text out of the file
// that calls it, so the predicate check above stops seeing it. The tenant is now
// carried in the caller's column list instead — which is still in the caller's
// file, and still checkable. Without this, cleaning up duplication would have
// quietly bought a weaker gate.
// A call, not a declaration: `function insertReturning<Row>(` is where the helper
// is defined, and its own parameters are not a column list.
function sharedInsertPattern(helper) {
  return new RegExp(`(?<!function\\s)${escape(helper)}\\s*(?:<[^>]*>)?\\s*\\(`, "g");
}

function tenantLiteralPattern(column) {
  return new RegExp(`["']${escape(column)}["']`);
}

/** The arguments of a call, split at the top level so a nested array stays whole. */
function callArguments(source, openIndex) {
  const args = [];
  let depth = 0;
  let current = "";
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) {
        args.push(current);
        return args;
      }
    }
    if (ch === "," && depth === 1) {
      args.push(current);
      current = "";
      continue;
    }
    if (!(depth === 1 && i === openIndex)) current += ch;
  }
  return args;
}

/**
 * The body of the factory a call passed its columns to. Only a call — `f()` — is
 * followed. A bare name is left to the enclosing-function window, because a local
 * one is free to repeat: resolving `columns` by name would find the first `const
 * columns` in the file and let a correct list two functions away vouch for this one.
 */
function factoryBody(source, argument) {
  const called = /^([A-Za-z_$][\w$]*)\s*\(/.exec(argument.trim());
  if (called === null) return "";
  const declared = new RegExp(`function\\s+${called[1]}\\b`).exec(source);
  return declared === null ? "" : source.slice(declared.index, declared.index + 700);
}

/**
 * Every call to the shared insert must name the tenant column: inline in the
 * argument list, in a `columns` array built just above it, or in the definition
 * of whatever it passed — a named factory is one indirection and is followed,
 * because a check that cries wolf is a check somebody turns off.
 *
 * @param {{path: string, source: string}[]} resources
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkSharedInsertCallSites(resources, options = {}) {
  const column = options.column ?? DEFAULT_TENANT_COLUMN;
  const sharedInsert = sharedInsertPattern(options.insertHelper ?? DEFAULT_INSERT_HELPER);
  const tenantLiteral = tenantLiteralPattern(column);
  const problems = [];
  for (const { path, source } of resources) {
    sharedInsert.lastIndex = 0;
    let match = sharedInsert.exec(source);
    while (match !== null) {
      // Look back only as far as the enclosing function starts, so a neighbouring
      // insert that does name the tenant cannot vouch for this one, and forward
      // across this call's own argument list.
      const before = source.slice(0, match.index);
      const boundary = Math.max(
        before.lastIndexOf("function "),
        before.lastIndexOf("=> {"),
        before.lastIndexOf("\n}"),
      );
      const from = boundary === -1 ? Math.max(0, match.index - 400) : boundary;
      const args = callArguments(source, match.index + match[0].length - 1);
      const followed = factoryBody(source, args[2] ?? "");
      const neighbourhood = source.slice(from, match.index + 700) + followed;
      if (!tenantLiteral.test(neighbourhood)) {
        problems.push({
          path,
          rule: "insert-without-tenant",
          detail: `line ${before.split("\n").length}: a shared insert names no ${column} column — the tenant moved into the caller's list, so the caller is what carries it`,
        });
      }
      match = sharedInsert.exec(source);
    }
  }
  return problems;
}

/** Every statement whose exemption was taken, so a reviewer can count them. */
export function exemptions(resources) {
  const taken = [];
  for (const { path, statements } of resources) {
    for (const { exemption } of statements) {
      if (exemption) taken.push({ path, reason: exemption });
    }
  }
  return taken;
}
