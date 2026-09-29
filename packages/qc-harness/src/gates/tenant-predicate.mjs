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
// A specifier to one of these is data, not a module, so it cannot re-export the helper.
const ASSET = /\.(?:json|css|scss|less|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|md|html|txt|ya?ml|csv|sql|wasm|mp4)$/i;
/** How many barrels a chain may pass through. A longer one fails closed. */
const MAX_BARREL_DEPTH = 8;

/** The scanned file a specifier points at: the path itself, or with an extension, or its `index`. */
function fileFor(candidates, known) {
  for (const candidate of candidates) {
    const base = candidate.replace(/\.[cm]?[jt]sx?$/, "");
    const tries = [candidate, ...SOURCE_EXTENSIONS.flatMap((ext) => [`${base}${ext}`, `${base}/index${ext}`])];
    const found = tries.find((name) => known.has(name));
    if (found !== undefined) return found;
  }
  return null;
}

const partsOf = (list) => list.split(",").map((part) => part.trim().split(/\s+as\s+/)).filter(([name]) => name !== "");

/**
 * What one run of the gate reads from: the aliases, the contents of every scanned file, the paths
 * of files the scan knows hold no re-export, and a cache of barrels already read.
 * `taint` counts reads cut short by a cycle or the cap. `seen` is the deepest chain under the
 * barrel being read.
 */
function contextOf(files, options) {
  return {
    aliases: options.aliases ?? [],
    sources: new Map(files.map((file) => [file.path, file.contents])),
    leaves: options.leaves ?? new Set(),
    cache: new Map(),
    taint: 0,
    seen: 0,
  };
}

/**
 * What a specifier leads to. `helper`: the module itself. `barrel`: a scanned file, read for its
 * re-exports. `cycle` and `capped`: a read cut short. `known`: a package, an asset or a file the scan
 * knows re-exports nothing. `untraceable`: a local file the gate cannot read.
 */
function readModule(from, specifier, helper, ctx, trail) {
  const candidates = candidatesOf(from, specifier, ctx.aliases);
  const target = stem(helper.module);
  if (candidates.some((candidate) => stem(candidate) === target)) return { kind: "helper" };
  const path = fileFor(candidates, ctx.sources);
  if (path === null) {
    const known = candidates.length === 0 || ASSET.test(specifier) || fileFor(candidates, ctx.leaves) !== null;
    return { kind: known ? "known" : "untraceable" };
  }
  if (trail.visited.has(path)) {
    ctx.taint += 1;
    return { kind: "cycle" };
  }
  if (trail.depth >= MAX_BARREL_DEPTH) {
    ctx.taint += 1;
    return { kind: "capped" };
  }
  const key = `${helper.module}\0${helper.name}\0${path}`;
  let exports = ctx.cache.get(key);
  // A finished read holds anywhere, as long as its chain still fits under the cap from here.
  if (exports === undefined || trail.depth + exports.height > MAX_BARREL_DEPTH) {
    exports = reexportsOf(path, ctx.sources.get(path), helper, ctx, { visited: new Set([...trail.visited, path]), depth: trail.depth + 1 });
  }
  ctx.seen = Math.max(ctx.seen, exports.height);
  return { kind: "barrel", exports };
}

/**
 * What a barrel exports of the helper: the names it exports the helper under, an `export *` that
 * reaches it, namespaces of it (each with the member names), and names or a star it cannot trace.
 * It follows a re-export through other barrels, so a rename at any depth maps back.
 */
function reexportsOf(barrel, source, helper, ctx, trail) {
  const found = { named: new Set(), star: false, namespaces: new Map(), opaque: new Set(), opaqueStar: false, height: 1 };
  const taintBefore = ctx.taint;
  const seenBefore = ctx.seen;
  ctx.seen = 0;
  const read = (specifier) => readModule(barrel, specifier, helper, ctx, trail);
  const membersOf = (exports) => new Set([...exports.named, ...(exports.star ? [helper.name] : [])]);

  for (const [, list, specifier] of source.matchAll(/\bexport\s+\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const module = read(specifier);
    for (const [name, renamed] of partsOf(list)) {
      const exported = renamed ?? name;
      if (module.kind === "helper") {
        if (name === helper.name) found.named.add(exported);
      } else if (module.kind === "barrel") {
        const there = module.exports;
        if (there.named.has(name) || (there.star && name === helper.name)) found.named.add(exported);
        if (there.namespaces.has(name)) found.namespaces.set(exported, there.namespaces.get(name));
        if (there.opaque.has(name) || there.opaqueStar) found.opaque.add(exported);
      } else if (module.kind === "capped" || module.kind === "untraceable" || (module.kind === "known" && name === helper.name)) {
        found.opaque.add(exported);
      }
    }
  }
  for (const [, specifier] of source.matchAll(/\bexport\s+\*\s*from\s*["']([^"']+)["']/g)) {
    const module = read(specifier);
    if (module.kind === "helper") {
      found.star = true;
    } else if (module.kind === "barrel") {
      const there = module.exports;
      found.star ||= there.star;
      for (const name of there.named) found.named.add(name);
      for (const [name, members] of there.namespaces) found.namespaces.set(name, members);
      for (const name of there.opaque) found.opaque.add(name);
      found.opaqueStar ||= there.opaqueStar;
    } else if (module.kind === "capped" || module.kind === "untraceable") {
      found.opaqueStar = true;
    }
  }
  for (const [, name, specifier] of source.matchAll(/\bexport\s+\*\s*as\s+([\w$]+)\s+from\s*["']([^"']+)["']/g)) {
    const module = read(specifier);
    if (module.kind === "helper") {
      found.namespaces.set(name, new Set([helper.name]));
    } else if (module.kind === "barrel") {
      const members = membersOf(module.exports);
      if (members.size > 0) found.namespaces.set(name, members);
      if (module.exports.opaque.size > 0 || module.exports.opaqueStar) found.opaque.add(name);
    } else if (module.kind === "capped" || module.kind === "untraceable") {
      found.opaque.add(name);
    }
  }
  // A barrel that imports the helper, or a re-export of it, and exports the local name.
  const local = helperImports(barrel, source, helper, ctx, trail);
  for (const [, list] of source.matchAll(/\bexport\s+\{([^}]*)\}(?!\s*from\b)/g)) {
    for (const [name, renamed] of partsOf(list)) {
      const exported = renamed ?? name;
      if (local.names.includes(name)) found.named.add(exported);
      for (const space of local.namespaces.filter((entry) => entry.local === name)) {
        found.namespaces.set(exported, new Set([...(found.namespaces.get(exported) ?? []), space.member]));
      }
      if (local.unresolved.some((entry) => entry.local === name)) found.opaque.add(exported);
    }
  }

  found.height = 1 + ctx.seen;
  ctx.seen = Math.max(seenBefore, found.height);
  // A read cut short by a cycle depends on where it started, so only a complete one is kept.
  if (ctx.taint === taintBefore) ctx.cache.set(`${helper.module}\0${helper.name}\0${barrel}`, found);
  return found;
}

/**
 * How a file imports `helper.name` from `helper.module`: the local names, the namespaces whose
 * `member` is the helper, and the imports the gate cannot resolve to the module. A local barrel is
 * followed to the module, through renames. A barrel it cannot trace fails closed.
 * @returns {{names: string[], namespaces: {local: string, member: string}[], unresolved: {specifier: string, name: string, local: string}[]}}
 */
function helperImports(file, source, helper, ctx, trail = { visited: new Set([file]), depth: 0 }) {
  const result = { names: [], namespaces: [], unresolved: [] };
  const target = stem(helper.module);
  for (const [, list, specifier] of source.matchAll(/\bimport\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const module = readModule(file, specifier, helper, ctx, trail);
    for (const [imported, renamed] of partsOf(list)) {
      const local = renamed ?? imported;
      if (module.kind === "helper") {
        if (imported === helper.name) result.names.push(local);
      } else if (module.kind === "barrel") {
        const there = module.exports;
        if (there.named.has(imported) || (there.star && imported === helper.name)) result.names.push(local);
        else if (there.namespaces.has(imported)) for (const member of there.namespaces.get(imported)) result.namespaces.push({ local, member });
        else if (imported === helper.name || there.opaque.has(imported) || there.opaqueStar) result.unresolved.push({ specifier, name: imported, local });
      } else if (imported === helper.name || module.kind === "capped") {
        result.unresolved.push({ specifier, name: imported, local });
      }
    }
  }
  for (const [, local, specifier] of source.matchAll(/\bimport\s+(?:[\w$]+\s*,\s*)?\*\s*as\s+([\w$]+)\s+from\s*["']([^"']+)["']/g)) {
    const module = readModule(file, specifier, helper, ctx, trail);
    if (module.kind === "helper") {
      result.namespaces.push({ local, member: helper.name });
    } else if (module.kind === "barrel") {
      const there = module.exports;
      for (const member of new Set([...there.named, ...(there.star ? [helper.name] : [])])) result.namespaces.push({ local, member });
      if (there.opaque.size > 0 || there.opaqueStar) result.unresolved.push({ specifier, name: "*", local });
    } else if (module.kind === "capped" || namesModule(file, specifier, target, ctx.aliases)) {
      result.unresolved.push({ specifier, name: "*", local });
    }
  }
  return result;
}

/**
 * Every call of an exempt helper, in a file that imports it from its module, with the argument
 * that carries the tenant and whether that argument names it.
 * @param {{path: string, contents: string}[]} files
 * @param {{module: string, name: string, argument: number}[]} helpers
 * @param {{column?: string, identifier?: string, aliases?: ReturnType<typeof aliasMap>, leaves?: Set<string>}} [options]
 * @returns {{path: string, line: number, name: string, index: number, argument: string, scoped: boolean}[]}
 */
export function exemptHelperCalls(files, helpers, options = {}) {
  const tenant = tenantPattern(options.column ?? DEFAULT_TENANT_COLUMN, options.identifier ?? DEFAULT_TENANT_IDENTIFIER);
  const calls = [];
  const ctx = contextOf(files, options);
  for (const { path, contents: source } of files) {
    for (const helper of helpers) {
      const { names, namespaces } = helperImports(path, source, helper, ctx);
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
 * @param {{column?: string, identifier?: string, aliases?: ReturnType<typeof aliasMap>, leaves?: Set<string>}} [options]
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
 * @param {{aliases?: ReturnType<typeof aliasMap>, leaves?: Set<string>}} [options]
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function unresolvedHelperImports(files, helpers, options = {}) {
  const problems = [];
  const ctx = contextOf(files, options);
  for (const { path, contents: source } of files) {
    const bySpecifier = new Map();
    for (const helper of helpers) {
      for (const { specifier, name } of helperImports(path, source, helper, ctx).unresolved) {
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
