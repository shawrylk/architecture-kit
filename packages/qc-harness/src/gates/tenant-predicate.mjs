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

/**
 * A call, not the declaration: the helper's own parameters are not a tenant argument. A `prefix`
 * makes it a member call, `ns.name(`, for a namespace import.
 */
function callPattern(name, prefix = "") {
  const member = prefix ? `${escape(prefix)}\\s*\\.\\s*` : "";
  return new RegExp(`(?<![\\w$.]|function\\s)${member}${escape(name)}\\s*(?:<[^>]*>)?\\s*\\(`, "g");
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

/** A path without its extension, and without a trailing `index`, so a folder and its index file are one. */
const stem = (spec) => spec.replace(/\.[cm]?[jt]sx?$/, "").replace(/\/index$/, "");

/** JSONC to JSON: comments and trailing commas go, and a `/*` inside a string stays. */
function stripJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * The path aliases of one tsconfig, as root-relative targets. Only that file is read: an `extends`
 * chain is not followed, so its aliases must be repeated there, or the import fails as unresolved.
 * @param {string} tsconfigText the file's contents; comments and trailing commas are allowed
 * @param {string} [dir] the folder of the tsconfig, relative to the repository root
 * @returns {{prefix: string, wildcard: boolean, targets: string[]}[]}
 */
export function aliasMap(tsconfigText, dir = "") {
  let options;
  try {
    options = JSON.parse(stripJsonc(tsconfigText))?.compilerOptions ?? {};
  } catch (error) {
    throw new Error(`the tsconfig is not valid JSON: ${error.message}`);
  }
  const base = posix.join(dir || ".", options.baseUrl ?? ".");
  const map = [];
  for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
    const star = pattern.indexOf("*");
    if (star !== -1 && star !== pattern.length - 1) continue;
    const resolvedTargets = [].concat(targets).map((target) => posix.join(base, target));
    map.push({ prefix: star === -1 ? pattern : pattern.slice(0, star), wildcard: star !== -1, targets: resolvedTargets });
  }
  // A `baseUrl` also makes every bare specifier a path under it.
  if (options.baseUrl !== undefined) map.push({ prefix: "", wildcard: true, targets: [posix.join(base, "*")] });
  return map;
}

/** Where a specifier may point, from the root: a relative one directly, any other through the aliases. */
function candidatesOf(file, specifier, aliases) {
  if (specifier.startsWith(".")) return [posix.join(posix.dirname(file), specifier)];
  const found = [];
  for (const { prefix, wildcard, targets } of aliases) {
    if (!(wildcard ? specifier.startsWith(prefix) : specifier === prefix)) continue;
    for (const target of targets) found.push(wildcard ? target.replace("*", specifier.slice(prefix.length)) : target);
  }
  return found;
}

/** A namespace import carries no name to match, so it counts only when its specifier points at the module or its folder. */
function namesModule(file, specifier, target, aliases) {
  if (posix.basename(stem(specifier)) === posix.basename(target)) return true;
  return candidatesOf(file, specifier, aliases).some((candidate) => target.startsWith(`${stem(candidate)}/`));
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** The scanned file a specifier points at: the path itself, or with an extension, or its `index`. */
function fileFor(candidates, sources) {
  for (const candidate of candidates) {
    const base = candidate.replace(/\.[cm]?[jt]sx?$/, "");
    const tries = [candidate, ...SOURCE_EXTENSIONS.flatMap((ext) => [`${base}${ext}`, `${base}/index${ext}`])];
    const found = tries.find((name) => sources.has(name));
    if (found !== undefined) return found;
  }
  return null;
}

const partsOf = (list) => list.split(",").map((part) => part.trim().split(/\s+as\s+/)).filter(([name]) => name !== "");

/**
 * What a barrel exports of the helper, read one level: the names it exports the helper under, an
 * `export *` from the module, namespaces of the module, and names it exports from a specifier the
 * gate cannot resolve. A re-export of a re-export is not followed.
 * @returns {{named: Set<string>, star: boolean, namespaces: Set<string>, opaque: Set<string>}}
 */
function reexportsOf(barrel, source, helper, aliases) {
  const target = stem(helper.module);
  const resolves = (specifier) => candidatesOf(barrel, specifier, aliases).some((candidate) => stem(candidate) === target);
  const found = { named: new Set(), star: false, namespaces: new Set(), opaque: new Set() };
  for (const [, list, specifier] of source.matchAll(/\bexport\s+\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    for (const [name, exported] of partsOf(list)) {
      if (name !== helper.name) continue;
      (resolves(specifier) ? found.named : found.opaque).add(exported ?? name);
    }
  }
  for (const [, specifier] of source.matchAll(/\bexport\s+\*\s*from\s*["']([^"']+)["']/g)) {
    if (resolves(specifier)) found.star = true;
  }
  for (const [, name, specifier] of source.matchAll(/\bexport\s+\*\s*as\s+([\w$]+)\s+from\s*["']([^"']+)["']/g)) {
    if (resolves(specifier)) found.namespaces.add(name);
  }
  // A barrel that imports the helper and exports the local name.
  const { names } = helperImports(barrel, source, helper, aliases, null);
  for (const [, list] of source.matchAll(/\bexport\s+\{([^}]*)\}(?!\s*from\b)/g)) {
    for (const [name, exported] of partsOf(list)) {
      if (names.includes(name)) found.named.add(exported ?? name);
    }
  }
  return found;
}

/**
 * How a file imports `helper.name` from `helper.module`: the local names, the namespaces whose
 * `member` is the helper, and the specifiers the gate cannot resolve to the module. A local barrel
 * that `sources` holds is read one level, so a renamed re-export maps back to the helper. Any other
 * barrel fails closed.
 * @param {Map<string, string> | null} sources scanned file contents by path; null reads no barrel
 * @returns {{names: string[], namespaces: {local: string, member: string}[], unresolved: {specifier: string, name: string}[]}}
 */
function helperImports(file, source, helper, aliases = [], sources = new Map()) {
  const target = stem(helper.module);
  const candidates = (specifier) => candidatesOf(file, specifier, aliases);
  const resolves = (specifier) => candidates(specifier).some((candidate) => stem(candidate) === target);
  const barrelOf = (specifier) => {
    const path = sources === null ? null : fileFor(candidates(specifier), sources);
    return path === null ? null : reexportsOf(path, sources.get(path), helper, aliases);
  };
  const result = { names: [], namespaces: [], unresolved: [] };
  for (const [, list, specifier] of source.matchAll(/\bimport\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const barrel = resolves(specifier) ? null : barrelOf(specifier);
    for (const [imported, local] of partsOf(list)) {
      if (resolves(specifier)) {
        if (imported === helper.name) result.names.push(local ?? imported);
      } else if (barrel?.named.has(imported) || (barrel?.star && imported === helper.name)) {
        result.names.push(local ?? imported);
      } else if (barrel?.namespaces.has(imported)) {
        result.namespaces.push({ local: local ?? imported, member: helper.name });
      } else if (imported === helper.name || barrel?.opaque.has(imported)) {
        result.unresolved.push({ specifier, name: imported });
      }
    }
  }
  for (const [, local, specifier] of source.matchAll(/\bimport\s+(?:[\w$]+\s*,\s*)?\*\s*as\s+([\w$]+)\s+from\s*["']([^"']+)["']/g)) {
    if (resolves(specifier)) {
      result.namespaces.push({ local, member: helper.name });
      continue;
    }
    const barrel = barrelOf(specifier);
    if (barrel === null) {
      if (namesModule(file, specifier, target, aliases)) result.unresolved.push({ specifier, name: "*" });
      continue;
    }
    if (barrel.star) result.namespaces.push({ local, member: helper.name });
    for (const member of barrel.named) result.namespaces.push({ local, member });
    if (barrel.opaque.size > 0) result.unresolved.push({ specifier, name: "*" });
  }
  return result;
}

/**
 * Every call of an exempt helper, in a file that imports it from its module, with the argument
 * that carries the tenant and whether that argument names it.
 * @param {{path: string, contents: string}[]} files
 * @param {{module: string, name: string, argument: number}[]} helpers
 * @param {{column?: string, identifier?: string, aliases?: ReturnType<typeof aliasMap>}} [options]
 * @returns {{path: string, line: number, name: string, index: number, argument: string, scoped: boolean}[]}
 */
export function exemptHelperCalls(files, helpers, options = {}) {
  const tenant = tenantPattern(options.column ?? DEFAULT_TENANT_COLUMN, options.identifier ?? DEFAULT_TENANT_IDENTIFIER);
  const calls = [];
  const sources = new Map(files.map((file) => [file.path, file.contents]));
  for (const { path, contents: source } of files) {
    for (const helper of helpers) {
      const { names, namespaces } = helperImports(path, source, helper, options.aliases, sources);
      const patterns = [...names.map((local) => callPattern(local)), ...namespaces.map(({ local, member }) => callPattern(member, local))];
      for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
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
 * @param {{column?: string, identifier?: string, aliases?: ReturnType<typeof aliasMap>}} [options]
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

/**
 * A file that imports an exempt helper by a specifier the gate cannot resolve to the helper's
 * module, an alias no tsconfig maps or a barrel that re-exports it, has calls the gate cannot see.
 * That is a finding, not a pass.
 * @param {{path: string, contents: string}[]} files
 * @param {{module: string, name: string, argument: number}[]} helpers
 * @param {{aliases?: ReturnType<typeof aliasMap>}} [options]
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function unresolvedHelperImports(files, helpers, options = {}) {
  const problems = [];
  const sources = new Map(files.map((file) => [file.path, file.contents]));
  for (const { path, contents: source } of files) {
    const bySpecifier = new Map();
    for (const helper of helpers) {
      for (const { specifier, name } of helperImports(path, source, helper, options.aliases, sources).unresolved) {
        const label = name === "*" ? `a namespace of ${helper.module}` : name;
        bySpecifier.set(specifier, new Set([...(bySpecifier.get(specifier) ?? []), label]));
      }
    }
    for (const [specifier, labels] of bySpecifier) {
      problems.push({
        path,
        rule: "unresolved-helper-import",
        detail: `imports ${[...labels].join(", ")} from '${specifier}', which the gate cannot resolve to the exempt helper's module, so its calls are not checked. Import it from the module by a relative path, or map the alias in the tsconfig that tenantPredicate.tsconfig names`,
      });
    }
  }
  return problems.sort((a, b) => a.path.localeCompare(b.path) || a.detail.localeCompare(b.detail));
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
