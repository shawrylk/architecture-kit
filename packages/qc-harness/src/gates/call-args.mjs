// Reading a call at its site: where it starts, its arguments split at the top level, and the text
// an argument stands for. Shared by the gates that judge an argument, not the statement around it.

export function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A call, not the declaration: the helper's own parameters are not a tenant argument. A `prefix`,
 * a list of names, makes it a member call, `ns.inner.name(`, for a namespace import.
 */
export function callPattern(name, prefix = []) {
  const member = prefix.map((segment) => `${escape(segment)}\\s*\\.\\s*`).join("");
  return new RegExp(`(?<![\\w$.]|function\\s)${member}${escape(name)}\\s*(?:<[^>]*>)?\\s*\\(`, "g");
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

/** Where each argument of a call starts and ends, split at the top level so a nested array stays whole. */
export function argumentSpans(source, openIndex) {
  const spans = [];
  let depth = 0;
  let start = openIndex + 1;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) {
        spans.push({ start, end: i });
        return spans;
      }
    }
    if (ch === "," && depth === 1) {
      spans.push({ start, end: i });
      start = i + 1;
    }
  }
  return spans;
}

/** The arguments of a call, split at the top level so a nested array stays whole. */
export function callArguments(source, openIndex) {
  return argumentSpans(source, openIndex).map(({ start, end }) => source.slice(start, end));
}

/** The nearest declaration of `name` inside the enclosing function, else at the top level. */
export function declarationOf(source, name, from, callAt) {
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
export function resolved(source, argument, from, callAt) {
  const called = /^([A-Za-z_$][\w$]*)\s*\(/.exec(argument);
  if (called) {
    const declared = new RegExp(`function\\s+${escape(called[1])}\\s*(?:<[^>]*>)?\\s*\\(`).exec(source);
    if (declared === null) return declarationOf(source, called[1], from, callAt);
    const open = source.indexOf("{", closeOf(source, declared.index + declared[0].length - 1));
    return open === -1 ? "" : source.slice(open, closeOf(source, open));
  }
  return /^[A-Za-z_$][\w$]*$/.test(argument) ? declarationOf(source, argument, from, callAt) : "";
}
