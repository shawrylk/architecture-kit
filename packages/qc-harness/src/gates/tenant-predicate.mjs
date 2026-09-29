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
 * A call, not the declaration: the helper's own parameters are not a tenant argument. A `prefix`,
 * a list of names, makes it a member call, `ns.inner.name(`, for a namespace import.
 */
function callPattern(name, prefix = []) {
  const member = prefix.map((segment) => `${escape(segment)}\\s*\\.\\s*`).join("");
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
 * A pattern whose `*` is not at the end has no target, but its prefix still marks a specifier as local.
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
    if (star !== -1 && star !== pattern.length - 1) {
      map.push({ prefix: pattern.slice(0, star), wildcard: true, targets: [] });
      continue;
    }
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

/** A specifier that names a file of this repository, not a package: relative, `@/`, `~/`, `#`, or an alias prefix. */
function looksLocal(specifier, aliases) {
  if (specifier.startsWith(".") || /^(?:\/|@\/|~\/|#)/.test(specifier)) return true;
  return aliases.some(({ prefix, wildcard }) => prefix !== "" && (wildcard ? specifier.startsWith(prefix) : specifier === prefix));
}

// ---- The module graph ------------------------------------------------------------------------
//
// One pass over each scanned file builds a record of its imports and exports. Nothing reads a file
// twice, and no read follows a chain: a name reaches a module by a worklist over the records. The
// regular expressions allow no whitespace (`import{x}from"y"`), and a statement starts a line, so a
// commented-out one is not read.

/** The most steps the worklist takes over all helpers, before the gate fails closed. */
const STEP_BUDGET = 50_000;
/** A namespace path longer than this, `a.b.c.d.name`, makes its module opaque. */
const MAX_PATH_SEGMENTS = 4;
/** A module that holds more member paths than this for one helper is opaque: self-aliasing namespaces grow them as K to the fourth. */
const MAX_PATHS = 64;

const LEAD = String.raw`(?:^|;|\*\/)[ \t]*`;
const CHAIN = String.raw`[\w$]+(?:\s*\.\s*[\w$]+)*`;
const TAIL = String.raw`[ \t]*(?:\/\/[^\n]*)?(?=;|$)`;
const STATEMENTS = {
  imports: new RegExp(String.raw`${LEAD}import(?![\w$])([^'";]*?)from\s*(["'])([^"']+)\2`, "gm"),
  from: new RegExp(String.raw`${LEAD}export(?![\w$])\s*(?:\*\s*(?:as\s+([\w$]+))?|\{([^}]*)\})\s*from\s*(["'])([^"']+)\3`, "gm"),
  listed: new RegExp(String.raw`${LEAD}export\s*\{([^}]*)\}(?!\s*from\b)`, "gm"),
  consts: new RegExp(String.raw`${LEAD}export\s+(?:const|let|var)\s+([\w$]+)\s*(?::[^=;\n]+)?=\s*(${CHAIN})${TAIL}`, "gm"),
  defaults: new RegExp(String.raw`${LEAD}export\s+default\s+(${CHAIN})${TAIL}`, "gm"),
};
const STRINGS = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;

// A small lexer, so a quote inside a comment, a template or a regular expression starts nothing. It blanks
// what is not code, keeps every newline and offset, and leaves a string alone when `keepStrings` is set,
// because a specifier is one. A template's text goes, and the code in its `${}` stays. A `/` starts a
// regular expression after an operator or a keyword, and divides after a name or a closing bracket.
const TOKENS = /\/[/*]|["'`/]/g;
const TOKENS_IN_TEMPLATE = /\/[/*]|["'`/{}]/g;
const REGEX_AFTER = /(?:(?<![+-])[+-]|[(,=:[!&|?{};*%~^]|=>|(?<![\w$.])(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await))\s*$/;

/** The index past the string that opens at `from`, or -1 when the line ends first. */
function stringEnd(source, from) {
  for (let i = from + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\\") i += 1;
    else if (ch === source[from]) return i + 1;
    else if (ch === "\n") return -1;
  }
  return -1;
}

/** The index past the regular expression that opens at `from`, or -1 when it is not one. */
function regexEnd(source, from) {
  let inClass = false;
  for (let i = from + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\n") return -1;
    if (ch === "\\") i += 1;
    else if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      let end = i + 1;
      while (end < source.length && /[a-z]/.test(source[end])) end += 1;
      return end;
    }
  }
  return -1;
}

/** The end of a template's text from `from`, and whether a `${` opened an expression there. */
function templateEnd(source, from) {
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\\") i += 1;
    else if (ch === "`") return [i + 1, false];
    else if (ch === "$" && source[i + 1] === "{") return [i + 2, true];
  }
  return [source.length, false];
}

function scrub(source, keepStrings) {
  const pieces = [];
  let copied = 0;
  const blank = (from, to) => {
    pieces.push(source.slice(copied, from));
    const dead = source.slice(from, to);
    pieces.push(dead.includes("\n") ? dead.replace(/[^\n]/g, " ") : " ".repeat(to - from));
    copied = to;
  };
  const expressions = [];
  let depth = 0;
  let pattern = TOKENS;
  let at = 0;
  for (;;) {
    pattern.lastIndex = at;
    const match = pattern.exec(source);
    if (match === null) break;
    const start = match.index;
    const token = match[0];
    at = start + token.length;
    if (token === "//") {
      const end = source.indexOf("\n", at);
      at = end === -1 ? source.length : end;
      blank(start, at);
    } else if (token === "/*") {
      const close = source.indexOf("*/", at);
      at = close === -1 ? source.length : close + 2;
      blank(start, at);
    } else if (token === "/") {
      const end = start === 0 || REGEX_AFTER.test(source.slice(Math.max(0, start - 20), start)) ? regexEnd(source, start) : -1;
      if (end !== -1) {
        blank(start, end);
        at = end;
      }
    } else if (token === "{") {
      depth += 1;
    } else if (token === "}" && !(expressions.length > 0 && depth === expressions.at(-1))) {
      depth -= 1;
    } else if (token === "`" || token === "}") {
      if (token === "}") expressions.pop();
      const [end, opened] = templateEnd(source, at);
      blank(start, end);
      at = end;
      if (opened) expressions.push(depth);
      pattern = expressions.length > 0 ? TOKENS_IN_TEMPLATE : TOKENS;
    } else {
      const end = stringEnd(source, start);
      if (end !== -1) {
        if (!keepStrings) blank(start, end);
        at = end;
      }
    }
  }
  if (pieces.length === 0) return source;
  pieces.push(source.slice(copied));
  return pieces.join("");
}

/** The parts of `a, b as c`, without a type-only part. */
const partsOf = (list) =>
  list
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "" && !/^type\s+(?!as\b)/.test(part))
    .map((part) => part.split(/\s+as\s+/));

/** What an import clause binds: a default, a namespace, and named imports. A type import binds nothing. */
function bindingsOf(clause) {
  const text = clause.trim();
  if (/^type[\s{*]/.test(text)) return [];
  const bindings = [];
  const head = /^([\w$]+)\s*(?:,|$)/.exec(text);
  const namespace = /\*\s*as\s+([\w$]+)/.exec(text);
  const named = /\{([^}]*)\}/.exec(text);
  if (head) bindings.push({ kind: "default", imported: "default", local: head[1] });
  if (namespace) bindings.push({ kind: "namespace", imported: "*", local: namespace[1] });
  if (named) for (const [name, renamed] of partsOf(named[1])) bindings.push({ kind: "named", imported: name, local: renamed ?? name });
  return bindings;
}

/**
 * A specifier resolved once: `to` is a scanned file, or a helper's module, or null. `missing` is a
 * local-looking specifier that reaches nothing, which the gate cannot read.
 */
function resolver(known, helperModules, aliases) {
  const cache = new Map();
  const resolve = (from, specifier) => {
    const candidates = candidatesOf(from, specifier, aliases);
    for (const candidate of candidates) {
      const module = helperModules.get(stem(candidate));
      if (module !== undefined) return { to: module, missing: false };
    }
    const to = fileFor(candidates, known);
    if (to !== null) return { to, missing: false };
    return { to: null, missing: !ASSET.test(specifier) && looksLocal(specifier, aliases) };
  };
  return (from, specifier) => {
    const key = specifier.startsWith(".") ? `${posix.dirname(from)}\0${specifier}` : specifier;
    let found = cache.get(key);
    if (found === undefined) {
      found = resolve(from, specifier);
      cache.set(key, found);
    }
    return found;
  };
}

/**
 * One scanned file: what it imports and what it exports, each with its resolved target. A leading
 * byte-order mark goes, and so do the comments, templates and regular expressions, before any
 * statement is read.
 */
function parseModule(path, contents, resolve) {
  const source = contents.charCodeAt(0) === 0xfeff ? contents.slice(1) : contents;
  const mentions = source.includes("import") || source.includes("export");
  const text = mentions ? scrub(source, true) : source;
  const record = { path, text, imports: [], reexports: [], stars: [], starAs: [], listed: [], consts: [], defaults: [], code: null, missing: false };
  if (source.includes("import")) {
    for (const [, clause, , specifier] of text.matchAll(STATEMENTS.imports)) {
      const target = resolve(path, specifier);
      for (const binding of bindingsOf(clause)) record.imports.push({ ...binding, specifier, to: target.to, missing: target.missing });
    }
  }
  if (!source.includes("export")) return record;
  for (const [, alias, list, , specifier] of text.matchAll(STATEMENTS.from)) {
    const target = resolve(path, specifier);
    record.missing ||= target.missing;
    if (list !== undefined) {
      for (const [name, renamed] of partsOf(list)) record.reexports.push({ ...target, imported: name, exported: renamed ?? name });
    } else if (alias !== undefined) {
      record.starAs.push({ ...target, exported: alias });
    } else {
      record.stars.push(target);
    }
  }
  for (const [, list] of text.matchAll(STATEMENTS.listed)) {
    for (const [name, renamed] of partsOf(list)) record.listed.push({ local: name, exported: renamed ?? name });
  }
  for (const [, exported, chain] of text.matchAll(STATEMENTS.consts)) record.consts.push({ exported, chain: chain.split(/\s*\.\s*/) });
  for (const [, chain] of text.matchAll(STATEMENTS.defaults)) record.defaults.push({ exported: "default", chain: chain.split(/\s*\.\s*/) });
  return record;
}

/** The records, who depends on whom, and the modules whose exports the gate cannot fully read. */
function buildGraph(files, helpers, aliases, leaves) {
  const known = new Set([...files.map((file) => file.path), ...leaves]);
  const helperModules = new Map(helpers.map((helper) => [stem(helper.module), fileFor([helper.module], known) ?? helper.module]));
  const resolve = resolver(known, helperModules, aliases);
  const records = new Map();
  const dependents = new Map();
  const importersOf = new Map();
  const unreadable = [];
  const depend = (to, path) => {
    if (to === null) return;
    const list = dependents.get(to);
    if (list === undefined) dependents.set(to, [path]);
    else if (list.at(-1) !== path) list.push(path);
  };
  for (const { path, contents } of files) {
    const record = parseModule(path, contents, resolve);
    records.set(path, record);
    for (const { to } of [...record.imports, ...record.reexports, ...record.stars, ...record.starAs]) depend(to, path);
    for (const { imported, kind } of record.imports) {
      if (kind !== "named") continue;
      const list = importersOf.get(imported);
      if (list === undefined) importersOf.set(imported, [path]);
      else if (list.at(-1) !== path) list.push(path);
    }
    if (record.missing) unreadable.push(path);
  }
  return { records, dependents, importersOf, unreadable, helperModules };
}

// ---- The fixed point -------------------------------------------------------------------------
//
// For one helper, `summaries` maps each module to what it exports of it. `names` maps an exported
// name to the member paths at which the helper sits under it: "" is the name itself, "crud" is
// `name.crud`. `all` and `opaque` mark what the gate cannot read: every export, or named ones.
// A summary only grows, so the worklist ends, and a cycle needs no special case.

const joined = (name, path) => (path === "" ? name : `${name}.${path}`);
const depthOf = (path) => (path === "" ? 0 : path.split(".").length);

/** Adds one member path under a name. Past the depth or the count limit the summary is `all` instead. True when it grew. */
function admit(summary, name, path) {
  let entry = summary.names.get(name);
  if (entry?.has(path)) return false;
  if (summary.count >= MAX_PATHS || depthOf(path) > MAX_PATH_SEGMENTS) {
    const grew = !summary.all;
    summary.all = true;
    return grew;
  }
  if (entry === undefined) {
    entry = new Set();
    summary.names.set(name, entry);
  }
  entry.add(path);
  summary.count += 1;
  return true;
}

function addPaths(summary, name, paths) {
  for (const path of paths) admit(summary, name, path);
}

/** Every path at which the helper sits under a namespace of the module. */
function namespacePaths(summary) {
  const paths = [];
  for (const [name, entry] of summary.names) for (const path of entry) paths.push(joined(name, path));
  return paths;
}

/** Adds `next` to `summary`, and says whether anything was new. */
function grow(summary, next) {
  let grew = false;
  for (const [name, paths] of next.names) {
    for (const path of paths) if (admit(summary, name, path)) grew = true;
  }
  for (const name of next.opaque) {
    if (!summary.opaque.has(name)) {
      summary.opaque.add(name);
      grew = true;
    }
  }
  if (next.all && !summary.all) {
    summary.all = true;
    grew = true;
  }
  return grew;
}

const newSummary = () => ({ names: new Map(), opaque: new Set(), all: false, count: 0 });

/** `const alias = name`, and its chain `let b = alias`: a plain alias of a name, on one line. */
const aliasOf = (name) => new RegExp(String.raw`(?<![\w$.])(?:const|let|var)\s+([\w$]+)\s*(?::[^=;\n]+)?=\s*${escape(name)}\s*(?=[;\n]|$)`, "g");

/** The names that denote the helper in its own module: its name, and each local alias of it. */
function ownNames(record, helper, state) {
  if (state.own !== undefined) return state.own;
  const code = codeOf(record);
  const names = new Set([helper.name]);
  for (let grew = true; grew; ) {
    grew = false;
    const before = names.size;
    for (const name of [...names]) for (const match of code.matchAll(aliasOf(name))) names.add(match[1]);
    for (const { exported, chain } of record.consts) if (chain.length === 1 && names.has(chain[0])) names.add(exported);
    grew = names.size > before;
  }
  state.own = names;
  return names;
}

/** The helper's own module exports its function as the default: `export default [async] function name`. */
function exportsDefaultFunction(record, helper) {
  const pattern = new RegExp(String.raw`${LEAD}export\s+default\s+(?:async\s+)?function\b\s*\*?\s*${escape(helper.name)}(?![\w$])`, "m");
  return pattern.test(codeOf(record));
}

/**
 * What a module's imports bind, for one helper: the local names and the member paths where the
 * helper sits, the locals the gate cannot follow, and the imports that do not resolve.
 */
function localsOf(record, helper, state, aliases) {
  const locals = new Map();
  const opaque = new Set();
  const unresolved = [];
  const origin = new Map();
  const bind = (local, paths, specifier) => {
    const entry = locals.get(local) ?? new Set();
    for (const path of paths) entry.add(path);
    locals.set(local, entry);
    if (!origin.has(local)) origin.set(local, specifier);
  };
  if (record.path === state.module) for (const name of ownNames(record, helper, state)) bind(name, [""], "the helper's own module");
  for (const imp of record.imports) {
    const summary = state.summaries.get(imp.to);
    if (imp.kind === "namespace") {
      if (summary !== undefined) {
        const paths = namespacePaths(summary);
        if (paths.length > 0) bind(imp.local, paths, imp.specifier);
        if (summary.all || summary.opaque.size > 0) {
          opaque.add(imp.local);
          unresolved.push({ specifier: imp.specifier, name: "*", why: "opaque" });
        }
      } else if (imp.to === null && namesModule(record.path, imp.specifier, stem(helper.module), aliases)) {
        opaque.add(imp.local);
        unresolved.push({ specifier: imp.specifier, name: "*", why: "unresolved" });
      }
      continue;
    }
    const paths = summary?.names.get(imp.imported);
    if (paths !== undefined) bind(imp.local, paths, imp.specifier);
    if (summary !== undefined && (summary.all || summary.opaque.has(imp.imported))) {
      opaque.add(imp.local);
      unresolved.push({ specifier: imp.specifier, name: imp.imported, why: "opaque" });
    } else if (paths === undefined && ((imp.kind === "named" && imp.imported === helper.name) || (imp.kind === "default" && imp.missing))) {
      opaque.add(imp.local);
      unresolved.push({ specifier: imp.specifier, name: imp.imported, why: "unresolved" });
    }
  }
  return { locals, opaque, unresolved, origin };
}

/** The member paths of a chain `a.b.c` that lead to the helper, given what `a` stands for. */
function throughChain(paths, chain) {
  const rest = [];
  for (const path of paths ?? []) {
    const segments = path === "" ? [] : path.split(".");
    if (chain.length <= segments.length && chain.every((segment, i) => segments[i] === segment)) rest.push(segments.slice(chain.length).join("."));
  }
  return rest;
}

/** What one module exports of the helper, from the summaries of the modules it reads. */
function exportsOf(record, helper, state, bound) {
  const out = newSummary();
  if (record.path === state.module) {
    addPaths(out, helper.name, [""]);
    if (exportsDefaultFunction(record, helper)) addPaths(out, "default", [""]);
  }
  const summaryOf = (to) => state.summaries.get(to);
  for (const { to, missing, imported, exported } of record.reexports) {
    const summary = summaryOf(to);
    if (summary?.names.has(imported)) addPaths(out, exported, summary.names.get(imported));
    if (missing || summary?.all || summary?.opaque.has(imported)) out.opaque.add(exported);
  }
  for (const { to, missing } of record.stars) {
    const summary = summaryOf(to);
    if (summary !== undefined) {
      for (const [name, paths] of summary.names) if (name !== "default") addPaths(out, name, paths);
      for (const name of summary.opaque) if (name !== "default") out.opaque.add(name);
      if (summary.all) out.all = true;
    }
    if (missing) out.all = true;
  }
  for (const { to, missing, exported } of record.starAs) {
    const summary = summaryOf(to);
    if (summary !== undefined) {
      addPaths(out, exported, namespacePaths(summary));
      if (summary.all || summary.opaque.size > 0) out.opaque.add(exported);
    }
    if (missing) out.opaque.add(exported);
  }
  for (const { local, exported } of record.listed) {
    if (bound.locals.has(local)) addPaths(out, exported, bound.locals.get(local));
    if (bound.opaque.has(local)) out.opaque.add(exported);
  }
  for (const { exported, chain } of [...record.consts, ...record.defaults]) {
    const [local, ...members] = chain;
    addPaths(out, exported, throughChain(bound.locals.get(local), members));
    if (bound.opaque.has(local)) out.opaque.add(exported);
  }
  return out;
}

/** The text of a module with its import and export statements, comments, templates, regular expressions and strings blanked. */
function codeOf(record) {
  if (record.code === null) {
    let text = record.text;
    for (const pattern of Object.values(STATEMENTS)) text = text.replace(pattern, (match) => " ".repeat(match.length));
    record.code = text.replace(STRINGS, " ");
  }
  return record.code;
}

const MEMBER = /\s*\.\s*([\w$]+)/y;
const CALL = /\s*(?:<[^>]*>)?\s*\(/y;

/** True when a use of `local` is anything but a call of the helper, or a member the helper is not under. */
function usedOtherwise(code, local, paths) {
  const pattern = new RegExp(String.raw`(?<![\w$.])${escape(local)}(?![\w$])`, "g");
  for (const match of code.matchAll(pattern)) {
    let at = match.index + match[0].length;
    const chain = [];
    for (;;) {
      MEMBER.lastIndex = at;
      const member = MEMBER.exec(code);
      if (member === null) break;
      chain.push(member[1]);
      at += member[0].length;
    }
    // An object key, `{ insertReturning: 1 }`, names nothing.
    const key = chain.length === 0 && /[{,]\s*$/.test(code.slice(Math.max(0, match.index - 40), match.index)) && /^\s*:(?!:)/.test(code.slice(at, at + 8));
    // `typeof insertReturning` reads a type or a string, and passes the helper nowhere.
    if (key || /\btypeof\s+$/.test(code.slice(Math.max(0, match.index - 12), match.index))) continue;
    for (const path of paths) {
      const segments = path === "" ? [] : path.split(".");
      const reaches = chain.length >= segments.length && segments.every((segment, i) => chain[i] === segment);
      const above = chain.length < segments.length && chain.every((segment, i) => segments[i] === segment);
      if (above) return true;
      if (!reaches) continue;
      if (chain.length > segments.length) return true;
      CALL.lastIndex = at;
      if (!CALL.test(code)) return true;
    }
  }
  return false;
}

/**
 * The code of the helper's own module without its declarations: `const alias = name`, and `const name`,
 * which are not uses. What remains of a name is a call, or a use the gate cannot follow.
 */
function ownUses(record, state) {
  let code = codeOf(record);
  const blanked = (match) => " ".repeat(match.length);
  for (const name of state.own) {
    code = code.replace(aliasOf(name), blanked);
    code = code.replace(new RegExp(String.raw`(?<![\w$.])(?:const|let|var)\s+${escape(name)}(?![\w$])`, "g"), blanked);
  }
  return code;
}

/** The locals of a module that the helper flows into other than by a call, an import or an export list. */
function offendersOf(record, locals, state) {
  let size = 0;
  for (const paths of locals.values()) size += paths.size;
  const hit = state.uses.get(record.path);
  if (hit !== undefined && hit.size === size) return hit.offenders;
  const code = record.path === state.module ? ownUses(record, state) : codeOf(record);
  const offenders = [...locals].filter(([local, paths]) => usedOtherwise(code, local, paths)).map(([local]) => local);
  state.uses.set(record.path, { size, offenders });
  return offenders;
}

/** Resolves one helper over the graph. `room` is how many steps are left of the budget. */
function resolveHelper(graph, helper, room, aliases) {
  const module = graph.helperModules.get(stem(helper.module));
  const state = { module, summaries: new Map(), uses: new Map() };
  const seed = newSummary();
  addPaths(seed, helper.name, [""]);
  state.summaries.set(module, seed);
  const queue = [];
  const queued = new Set();
  const enqueue = (path) => {
    if (queued.has(path) || !graph.records.has(path)) return;
    queued.add(path);
    queue.push(path);
  };
  enqueue(module);
  // Where the helper's name is imported, and where a re-export cannot be read, count from the start.
  for (const path of graph.dependents.get(module) ?? []) enqueue(path);
  for (const path of graph.importersOf.get(helper.name) ?? []) enqueue(path);
  for (const path of graph.unreadable) enqueue(path);
  let steps = 0;
  for (let next = 0; next < queue.length; next += 1) {
    if (steps >= room) return { state, steps, exceeded: true };
    steps += 1;
    const path = queue[next];
    queued.delete(path);
    const record = graph.records.get(path);
    const bound = localsOf(record, helper, state, aliases);
    const out = exportsOf(record, helper, state, bound);
    if (bound.locals.size > 0 && offendersOf(record, bound.locals, state).length > 0) out.all = true;
    let summary = state.summaries.get(path);
    if (summary === undefined) {
      summary = newSummary();
      state.summaries.set(path, summary);
    }
    if (grow(summary, out)) for (const dependent of graph.dependents.get(path) ?? []) enqueue(dependent);
  }
  let widest = 0;
  for (const { count } of state.summaries.values()) widest = Math.max(widest, count);
  return { state, steps, exceeded: false, widest };
}

/** What each module does with the helper, once the summaries are final. */
function reportHelper(graph, helper, state, aliases, found) {
  for (const record of graph.records.values()) {
    if (record.path === state.module) continue;
    const bound = localsOf(record, helper, state, aliases);
    if (bound.locals.size === 0 && bound.unresolved.length === 0) continue;
    const entry = found.get(record.path) ?? { path: record.path, patterns: [], unresolved: [], offenders: [] };
    for (const [local, paths] of bound.locals) for (const path of paths) entry.patterns.push({ helper, local, path });
    for (const item of bound.unresolved) entry.unresolved.push({ helper, ...item });
    if (bound.locals.size > 0) {
      for (const local of offendersOf(record, bound.locals, state)) entry.offenders.push({ helper, local, specifier: bound.origin.get(local) });
    }
    found.set(record.path, entry);
  }
}

const NO_ALIASES = Object.freeze([]);
const NO_LEAVES = new Set();
const RESOLUTIONS = new WeakMap();

/**
 * Where each exempt helper's names go: the calls to check, the imports the gate cannot resolve, and
 * the modules that use a helper in a way it cannot follow. It is computed once for a list of files,
 * so the three checks below share it. The memo assumes that the file list, and each entry in it, is not
 * mutated between calls. `steps` counts the worklist steps taken over all helpers, and `widest` is the
 * most member paths that one module holds for one helper.
 * Past `budget` steps the resolution stops, and `exceeded` is set.
 * @param {{path: string, contents: string}[]} files
 * @param {{module: string, name: string, argument: number}[]} helpers
 * @param {{aliases?: ReturnType<typeof aliasMap>, leaves?: Set<string>, budget?: number}} [options]
 */
export function resolveHelpers(files, helpers, options = {}) {
  const aliases = options.aliases ?? NO_ALIASES;
  const leaves = options.leaves ?? NO_LEAVES;
  const budget = options.budget ?? STEP_BUDGET;
  const cached = RESOLUTIONS.get(files);
  if (cached && cached.helpers === helpers && cached.aliases === aliases && cached.leaves === leaves && cached.budget === budget) return cached.resolution;
  const graph = buildGraph(files, helpers, aliases, leaves);
  const found = new Map();
  let steps = 0;
  let widest = 0;
  let stoppedAt = null;
  for (const helper of helpers) {
    const outcome = resolveHelper(graph, helper, budget - steps, aliases);
    steps += outcome.steps;
    widest = Math.max(widest, outcome.widest ?? 0);
    if (outcome.exceeded) {
      stoppedAt = helper;
      break;
    }
    reportHelper(graph, helper, outcome.state, aliases, found);
  }
  const resolution = { steps, budget, widest, exceeded: stoppedAt !== null, stoppedAt, files: stoppedAt === null ? [...found.values()] : [] };
  RESOLUTIONS.set(files, { helpers, aliases, leaves, budget, resolution });
  return resolution;
}

/**
 * Every call of an exempt helper, in a file that imports it from its module, with the argument
 * that carries the tenant and whether that argument names it.
 * @param {{path: string, contents: string}[]} files
 * @param {{module: string, name: string, argument: number}[]} helpers
 * @param {{column?: string, identifier?: string, aliases?: ReturnType<typeof aliasMap>, leaves?: Set<string>, budget?: number}} [options]
 * @returns {{path: string, line: number, name: string, index: number, argument: string, scoped: boolean}[]}
 */
export function exemptHelperCalls(files, helpers, options = {}) {
  const tenant = tenantPattern(options.column ?? DEFAULT_TENANT_COLUMN, options.identifier ?? DEFAULT_TENANT_IDENTIFIER);
  const sources = new Map(files.map((file) => [file.path, file.contents]));
  const calls = [];
  for (const { path, patterns } of resolveHelpers(files, helpers, options).files) {
    const source = sources.get(path);
    for (const { helper, local, path: member } of patterns) {
      const segments = member === "" ? [] : member.split(".");
      for (const match of source.matchAll(callPattern(segments.at(-1) ?? local, segments.length === 0 ? [] : [local, ...segments.slice(0, -1)]))) {
        // The enclosing function starts the window, so a neighbour cannot vouch for this call.
        const before = source.slice(0, match.index);
        const from = Math.max(0, before.lastIndexOf("function "), before.lastIndexOf("=> {"), before.lastIndexOf("\n}"));
        const argument = (callArguments(source, match.index + match[0].length - 1)[helper.argument] ?? "").trim();
        const scoped = tenant.test(argument) || tenant.test(resolved(source, argument, from, match.index));
        calls.push({ path, line: before.split("\n").length, name: helper.name, index: helper.argument, argument, scoped });
      }
    }
  }
  return calls.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

/**
 * @param {{path: string, contents: string}[]} files
 * @param {{module: string, name: string, argument: number}[]} helpers
 * @param {{column?: string, identifier?: string, aliases?: ReturnType<typeof aliasMap>, leaves?: Set<string>, budget?: number}} [options]
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

const REMEDY = "Import it from the module by a relative path, or map the alias in the tsconfig that tenantPredicate.tsconfig names";

/**
 * A file that reaches an exempt helper in a form the gate cannot follow has calls it cannot see.
 * That is a finding, not a pass. Three forms count. An import of the helper's name, or a namespace
 * of its module, by a specifier the gate cannot resolve to the module: an alias no tsconfig maps.
 * An import from an opaque module: one that re-exports from a local file the gate cannot read, or
 * that uses the helper other than by a call, an import or an export list. And the use itself, in a
 * file that imports the helper and stores it, as in `const f = insertReturning`. A resolution past
 * its step budget is one problem that names the budget.
 * @param {{path: string, contents: string}[]} files
 * @param {{module: string, name: string, argument: number}[]} helpers
 * @param {{aliases?: ReturnType<typeof aliasMap>, leaves?: Set<string>, budget?: number}} [options]
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function unresolvedHelperImports(files, helpers, options = {}) {
  const resolution = resolveHelpers(files, helpers, options);
  if (resolution.exceeded) {
    const { name, module } = resolution.stoppedAt;
    return [
      {
        path: module,
        rule: "unresolved-helper-import",
        detail: `following where ${name} is re-exported took more than the budget of ${resolution.budget} steps, so the gate stopped and its calls are not checked. Import the helper from its own module, and cut the cycles between barrels`,
      },
    ];
  }
  const problems = [];
  for (const { path, unresolved, offenders } of resolution.files) {
    const groups = new Map();
    for (const { helper, specifier, name, why } of unresolved) {
      const label = name === "*" ? `a namespace of ${helper.module}` : name;
      const key = `${why}\0${specifier}`;
      const group = groups.get(key) ?? { why, specifier, labels: new Set() };
      group.labels.add(label);
      groups.set(key, group);
    }
    for (const { why, specifier, labels } of groups.values()) {
      const list = [...labels].join(", ");
      problems.push({
        path,
        rule: "unresolved-helper-import",
        detail:
          why === "opaque"
            ? `imports ${list} from '${specifier}', which is opaque: it re-exports from a file the gate cannot read, or uses the exempt helper other than by a call, so the calls it exposes are not checked. ${REMEDY}`
            : `imports ${list} from '${specifier}', which the gate cannot resolve to the exempt helper's module, so its calls are not checked. ${REMEDY}`,
      });
    }
    if (offenders.length > 0) {
      const list = [...new Set(offenders.map(({ helper, local }) => `${local} (${helper.name})`))].join(", ");
      problems.push({
        path,
        rule: "unresolved-helper-import",
        detail: `uses ${list} other than by a call, an import or an export list, so the gate cannot tell which calls it must check. Call the exempt helper directly`,
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
