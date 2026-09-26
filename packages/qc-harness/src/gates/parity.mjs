// The two surfaces carry one architecture: a feature exists on both under one name, and a
// server slice has a client slice of the same stem. A divergence is legal only when the
// registry names it with its reason, and an entry that stops being true fails like a gap.
// A slice that only exists to satisfy this pairing is refused too, or the pairing proves nothing.

/**
 * @param {{
 *   server: {name: string, slices: string[], routes: string[]}[],
 *   client: {name: string, slices: string[]}[],
 *   registry: {backendOnlyFeatures?: {name: string}[], frontendOnlyFeatures?: {name: string}[], slices?: Record<string, {stem: string, why?: string}[]>},
 * }} surfaces
 * @param {{server: string, client: string, registry: string, trigger?: string}} roots
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkParity({ server, client, registry }, roots) {
  const where = roots.registry;
  const trigger = roots.trigger ?? "trigger.ts";
  const backend = server.map((feature) => feature.name);
  const frontend = client.map((feature) => feature.name);
  const backendOnly = new Set((registry.backendOnlyFeatures ?? []).map((entry) => entry.name));
  const frontendOnly = new Set((registry.frontendOnlyFeatures ?? []).map((entry) => entry.name));
  const problems = [];
  const push = (path, rule, detail) => problems.push({ path, rule, detail });

  for (const name of backend) {
    if (frontend.includes(name) || backendOnly.has(name)) continue;
    push(`${roots.server}/${name}`, "one-sided-feature", `${name}: served by the api with no client feature, and not named in ${where}`);
  }
  for (const name of frontend) {
    if (backend.includes(name) || frontendOnly.has(name)) continue;
    push(`${roots.client}/${name}`, "one-sided-feature", `${name}: a client feature the api does not serve, and not named in ${where}`);
  }
  for (const name of [...backendOnly, ...frontendOnly]) {
    if (backend.includes(name) && frontend.includes(name)) {
      push(where, "stale-divergence", `${name}: listed as one-sided in ${where}, but both surfaces have it — delete the entry`);
    }
  }

  const drawnBy = new Map(client.map((feature) => [feature.name, new Set(feature.slices)]));
  for (const feature of server.filter(({ name }) => drawnBy.has(name))) {
    const { name } = feature;
    const served = new Set(feature.slices);
    const drawn = drawnBy.get(name);
    const routes = [...new Set(feature.routes)].sort();
    const excuses = new Map((registry.slices?.[name] ?? []).map((entry) => [entry.stem, entry.why ?? ""]));
    const serverPath = `${roots.server}/${name}`;
    const clientPath = `${roots.client}/${name}`;

    for (const stem of routes) {
      if (!served.has(stem)) push(serverPath, "one-sided-slice", `${name}/${stem}: route in ${trigger} has no backend slice implementation`);
    }
    for (const stem of routes) {
      if (!drawn.has(stem) && !excuses.has(stem)) push(clientPath, "one-sided-slice", `${name}/${stem}: backend route has no frontend slice`);
    }
    for (const stem of [...served].sort()) {
      if (drawn.has(stem) || excuses.has(stem)) continue;
      push(clientPath, "one-sided-slice", `${name}/${stem}: a backend slice with no frontend slice of that name`);
    }
    for (const stem of [...drawn].sort()) {
      if (served.has(stem) || excuses.has(stem)) continue;
      push(serverPath, "one-sided-slice", `${name}/${stem}: a frontend slice with no backend slice/route of that name`);
    }
    for (const [stem, why] of excuses) {
      const stale = (detail) => push(where, "stale-divergence", `${name}/${stem}: ${detail}`);
      if (served.has(stem) && drawn.has(stem)) stale(`excused in ${where}, but both surfaces have it — delete the entry`);
      else if (!served.has(stem) && !drawn.has(stem)) stale(`excused in ${where}, but neither surface has a slice of that name — delete the entry`);
      else if (why.startsWith("Client-only") && !drawn.has(stem)) stale(`excused as client-only in ${where}, but no frontend slice exists`);
      else if (why.startsWith("Backend-only") && !served.has(stem)) stale(`excused as backend-only in ${where}, but no backend slice exists`);
    }
  }
  return problems;
}

// A string can hold "//" or a brace, so a comment is removed only outside a string.
const COMMENT_OR_STRING = /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
const NO_OP_STATEMENT = /^(?:void 0|return|return undefined|return void 0)$/;

/** The index just past the bracket that closes the one at `open`, skipping strings. */
function closing(source, open) {
  const pair = { "(": ")", "{": "}", "<": ">" }[source[open]];
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = source.indexOf(ch, i + 1);
      if (end === -1) return source.length;
      i = end;
    } else if (ch === source[open]) depth += 1;
    else if (ch === pair && (depth -= 1) === 0) return i + 1;
  }
  return source.length;
}

function isNoOpBody(body) {
  return body
    .split(/[;\n]/)
    .map((statement) => statement.trim())
    .filter(Boolean)
    .every((statement) => NO_OP_STATEMENT.test(statement));
}

/** True for a function whose parameters open at `open` and whose body does nothing. */
function noOpFunctionAt(source, open, { arrow }) {
  const after = source.slice(closing(source, open));
  if (arrow) {
    const head = /^\s*(?::[^=]*?)?=>\s*/.exec(after);
    if (head === null) return false;
    const rest = after.slice(head[0].length);
    if (rest.startsWith("{")) return isNoOpBody(rest.slice(1, closing(rest, 0) - 1));
    return /^(?:void 0|undefined)\s*(?:;|$|\n)/.test(rest);
  }
  const brace = after.indexOf("{");
  return brace !== -1 && isNoOpBody(after.slice(brace + 1, closing(after, brace) - 1));
}

/**
 * Each value export: true when it is a function that does nothing. A type export carries no
 * behavior and is skipped; anything else, a constant, a class or a re-export, is real.
 */
function valueExports(source) {
  const found = [];
  for (const match of source.matchAll(/(?:^|[;\n])\s*export\s+/g)) {
    const rest = source.slice(match.index + match[0].length);
    if (/^(?:type|interface|declare)\b/.test(rest)) continue;
    const declared = /^(?:default\s+)?(?:async\s+)?function\b\s*\*?\s*[\w$]*\s*(?:<[^>]*>\s*)?(?=\()/.exec(rest);
    if (declared) {
      found.push(noOpFunctionAt(rest, declared[0].length, { arrow: false }));
      continue;
    }
    const bound = /^(?:const|let|var)\s+[\w$]+\s*(?::[^=]+)?=\s*(?:async\s+)?/.exec(rest);
    if (bound) {
      const value = rest.slice(bound[0].length);
      const expression = /^function\b\s*[\w$]*\s*(?=\()/.exec(value);
      if (expression) found.push(noOpFunctionAt(value, expression[0].length, { arrow: false }));
      else if (value.startsWith("(")) found.push(noOpFunctionAt(value, 0, { arrow: true }));
      else if (/^[\w$]+\s*=>/.test(value)) found.push(noOpFunctionAt(`(${value.replace(/^([\w$]+)/, "$1)")}`, 0, { arrow: true }));
      else found.push(false);
      continue;
    }
    found.push(false);
  }
  return found;
}

/**
 * A slice file whose every value export is a function that does nothing: it pairs a name and
 * carries no behavior. A file with no value export is left to the empty-block check.
 * @param {{path: string, contents: string}[]} files
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function placeholderSlices(files) {
  const problems = [];
  for (const { path, contents } of files) {
    const exports = valueExports(contents.replace(COMMENT_OR_STRING, (whole, string) => string ?? ""));
    if (exports.length === 0 || !exports.every(Boolean)) continue;
    problems.push({
      path,
      rule: "placeholder-slice",
      detail: "every export is a function that does nothing, so the slice pairs a name and carries no behavior — build the slice, or name the divergence in the parity registry",
    });
  }
  return problems;
}
