// Tenant isolation is the security model, and its first leg is the repository
// predicate: every statement that touches a business table names the tenant.
// Each feature proves its own with a two-tenant test; this proves all of them at
// once, and proves it for the statement nobody wrote a test for.
// docs/architecture.md, .claude/rules/security.md.
//
// It reads the predicate, not the value. That a predicate is present is
// structural; that it is correct is what the two-tenant test is for.

import { posix } from "node:path";

const DEFAULT_TENANT_COLUMN = "tenant_id";
const DEFAULT_TENANT_IDENTIFIER = "tenantId";

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

// A helper that takes its table or its columns from the caller carries an exemption above,
// because the tenant is not readable inside it. The tenant is readable at each call, so each
// call is checked instead, or moving a statement into a shared helper buys a weaker gate.

/** A call, not the declaration: the helper's own parameters are not a tenant argument. */
function callPattern(name) {
  return new RegExp(`(?<![\\w$.]|function\\s)${escape(name)}\\s*(?:<[^>]*>)?\\s*\\(`, "g");
}

/** The tenant as a quoted column, as a row key, or as the tenant identifier. */
function tenantPattern(column, identifier) {
  return new RegExp(`["'\`]${escape(column)}["'\`]|\\b${escape(column)}\\s*:|\\b${escape(identifier)}\\b`);
}

/** The index just past the bracket that closes the one at `open`. */
function closeOf(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if ("([{".includes(source[i])) depth += 1;
    else if (")]}".includes(source[i]) && (depth -= 1) === 0) return i + 1;
  }
  return source.length;
}

/** From `at` to the semicolon that ends its statement, outside any bracket. */
function statementFrom(source, at) {
  let depth = 0;
  for (let i = at; i < source.length; i += 1) {
    if ("([{".includes(source[i])) depth += 1;
    else if (")]}".includes(source[i])) depth -= 1;
    if (depth < 0 || (depth === 0 && source[i] === ";")) return source.slice(at, i);
  }
  return source.slice(at);
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

/** The nearest declaration of `name` inside the enclosing function, else at the top level. */
function declarationOf(source, name, from, callAt) {
  const id = escape(name);
  const declares = `\\b(?:const|let|var)\\s+(?:\\{[^}]*\\b${id}\\b[^}]*\\}|\\[[^\\]]*\\b${id}\\b[^\\]]*\\]|${id}\\b)`;
  const local = [...source.slice(from, callAt).matchAll(new RegExp(declares, "g"))].at(-1);
  if (local) return statementFrom(source, from + local.index);
  const top = new RegExp(`^(?:export\\s+)?${declares}`, "m").exec(source);
  return top ? statementFrom(source, top.index) : "";
}

/**
 * The text an argument stands for. A call `f()` is followed to the body of `function f`, one
 * indirection. A bare name is followed to its own declaration only, so a neighbour's local of
 * the same name, or a values list beside it, cannot vouch for it.
 */
function resolved(source, argument, from, callAt) {
  const called = /^([A-Za-z_$][\w$]*)\s*\(/.exec(argument);
  if (called) {
    const declared = new RegExp(`function\\s+${escape(called[1])}\\s*(?:<[^>]*>)?\\s*\\(`).exec(source);
    if (declared === null) return declarationOf(source, called[1], from, callAt);
    const open = source.indexOf("{", closeOf(source, declared.index + declared[0].length - 1));
    return open === -1 ? "" : source.slice(open, closeOf(source, open));
  }
  return /^[A-Za-z_$][\w$]*$/.test(argument) ? declarationOf(source, argument, from, callAt) : "";
}

/** The local names a file imports `helper.name` under from `helper.module`. */
function importedNames(file, source, helper) {
  const stem = (spec) => spec.replace(/\.[cm]?[jt]sx?$/, "");
  const folder = posix.dirname(file);
  const names = [];
  for (const [, list, specifier] of source.matchAll(/\bimport\s+\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    if (!specifier.startsWith(".") || stem(posix.join(folder, specifier)) !== stem(helper.module)) continue;
    for (const part of list.split(",")) {
      const [imported, local] = part.trim().split(/\s+as\s+/);
      if (imported === helper.name) names.push(local ?? imported);
    }
  }
  return names;
}

/**
 * Every call of an exempt helper, in a file that imports it from its module, with the argument
 * that carries the tenant and whether that argument names it.
 * @param {{path: string, contents: string}[]} files
 * @param {{module: string, name: string, argument: number}[]} helpers
 * @param {{column?: string, identifier?: string}} [options]
 * @returns {{path: string, line: number, name: string, index: number, argument: string, scoped: boolean}[]}
 */
export function exemptHelperCalls(files, helpers, options = {}) {
  const tenant = tenantPattern(options.column ?? DEFAULT_TENANT_COLUMN, options.identifier ?? DEFAULT_TENANT_IDENTIFIER);
  const calls = [];
  for (const { path, contents: source } of files) {
    for (const helper of helpers) {
      for (const local of importedNames(path, source, helper)) {
        for (const match of source.matchAll(callPattern(local))) {
          // The enclosing function starts the window, so a neighbour cannot vouch for this call.
          const before = source.slice(0, match.index);
          const from = Math.max(0, before.lastIndexOf("function "), before.lastIndexOf("=> {"), before.lastIndexOf("\n}"));
          const argument = (callArguments(source, match.index + match[0].length - 1)[helper.argument] ?? "").trim();
          const scoped = tenant.test(argument) || tenant.test(resolved(source, argument, from, match.index));
          calls.push({ path, line: before.split("\n").length, name: helper.name, index: helper.argument, argument, scoped });
        }
      }
    }
  }
  return calls.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

/**
 * @param {{path: string, contents: string}[]} files
 * @param {{module: string, name: string, argument: number}[]} helpers
 * @param {{column?: string, identifier?: string}} [options]
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkExemptHelperCalls(files, helpers, options = {}) {
  return exemptHelperCalls(files, helpers, options)
    .filter((call) => !call.scoped)
    .map((call) => ({
      path: call.path,
      rule: "unscoped-helper-call",
      detail: `line ${call.line}: ${call.name} is exempt from the statement scan, and its argument ${call.index + 1} (${call.argument}) names no tenant — the caller is what carries it`,
    }));
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
