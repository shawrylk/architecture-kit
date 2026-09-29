// A saga resumes on its key. A runner that receives a key minted at the call starts a second saga
// on every retry, so the write that the key guards runs twice. The key must come from stored
// state, and the runner's argument is where a call site can be read for it.
//
// It reads a runner's object-literal argument, and follows a name to its `const` in scope. It
// reads text, not a syntax tree: the README lists the forms it does not see.

import { argumentSpans, callPattern, escape } from "./call-args.mjs";
import { scrub } from "./scrub.mjs";

const DEFAULT_KEY = "mutationId";
const DEFAULT_LEDGER_KEY = "ledger";
// `idempotency.volatile` lists the names a key must not be built from, and the runner passes it in.
// `uuid.v4` is the qualified form of a source that list names as `uuid`, so it always counts.
const ALWAYS_VOLATILE = ["uuid.v4"];
// A const that names another const is followed this far, so a cycle ends.
const MAX_CHAIN = 6;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const CHAIN = String.raw`[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*`;
const CALLS = new RegExp(String.raw`(?<![\w$])(${CHAIN})\s*(?:<[^>]*>)?\s*\(`, "g");
const NEW_DATE = /(?<![\w$.])new\s+Date\s*\(/;

function nameList(value, what, { empty }) {
  if (!Array.isArray(value) || (!empty && value.length === 0) || value.some((name) => typeof name !== "string" || name === "")) {
    throw new Error(`${what} must be ${empty ? "a list" : "a non-empty list"} of names, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** The index of the bracket that closes the one at `open`, or -1. */
function closerOf(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if ("([{".includes(text[i])) depth += 1;
    else if (")]}".includes(text[i]) && (depth -= 1) === 0) return i;
  }
  return -1;
}

/** The text of an expression with a wrapper that does not change its value taken off. */
function primaryOf(expression) {
  let text = expression.trim();
  for (;;) {
    const before = text;
    text = text.replace(/^await\s+/, "").replace(/\s+(?:as|satisfies)\s+[\w$.<>[\]\s|&]+$/, "").replace(/!$/, "").trim();
    if (text.startsWith("(") && closerOf(text, 0) === text.length - 1) text = text.slice(1, -1).trim();
    if (text === before) return text;
  }
}

/**
 * The parts of an expression that can be its value: both arms of `?:`, and every side of `??`, `||`
 * and `&&` but a guard, the side before an `&&`. A ternary's condition is not the value.
 */
function branchesOf(text) {
  const cuts = [];
  let question = -1;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
    else if (depth === 0) {
      const two = text.slice(i, i + 2);
      if (two === "??" || two === "||" || two === "&&") {
        cuts.push({ at: i, op: two });
        i += 1;
      } else if (ch === "?" && text[i + 1] !== "." && question === -1) {
        question = i;
      }
    }
  }
  if (question !== -1) {
    let nested = 0;
    depth = 0;
    for (let i = question + 1; i < text.length; i += 1) {
      const ch = text[i];
      if ("([{".includes(ch)) depth += 1;
      else if (")]}".includes(ch)) depth -= 1;
      else if (depth === 0 && ch === "?" && text[i + 1] !== "?" && text[i + 1] !== "." && text[i - 1] !== "?") nested += 1;
      else if (depth === 0 && ch === ":") {
        if (nested === 0) return [text.slice(question + 1, i), text.slice(i + 1)];
        nested -= 1;
      }
    }
    return [text.slice(question + 1)];
  }
  if (cuts.length === 0) return [text];
  const parts = [];
  let from = 0;
  for (const { at, op } of cuts) {
    if (op !== "&&") parts.push(text.slice(from, at));
    from = at + 2;
  }
  parts.push(text.slice(from));
  return parts;
}

/** The volatile call an expression holds anywhere, its arguments and a callback body included. */
function mintedCall(text, volatile) {
  if (NEW_DATE.test(text)) return "new Date";
  for (const match of text.matchAll(CALLS)) {
    const callee = match[1].replace(/\s+/g, "").replace(/\?\./g, ".");
    if (volatile.some((name) => callee === name || callee.endsWith(`.${name}`))) return callee;
  }
  return null;
}

/** True when the block that holds the declaration at `from` still holds `to`, so the name is in scope there. */
function reaches(code, from, to) {
  let depth = 0;
  for (let i = from; i < to; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}" && (depth -= 1) < 0) return false;
  }
  return true;
}

/** From `start` to the end of the expression: a `;`, a `,`, a closing bracket, or a line that no operator continues. */
function expressionFrom(code, start) {
  const continues = "?:=+-*/%&|,.<>!^~([";
  let depth = 0;
  for (let i = start; i < code.length; i += 1) {
    const ch = code[i];
    if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) {
      if ((depth -= 1) < 0) return code.slice(start, i);
    } else if (depth === 0 && (ch === ";" || ch === ",")) {
      return code.slice(start, i);
    } else if (depth === 0 && ch === "\n") {
      const before = code.slice(start, i).trimEnd().at(-1);
      const after = code.slice(i).trimStart()[0];
      if (before !== undefined && !continues.includes(before) && !(after !== undefined && "?:.&|+*/,=<>".includes(after))) return code.slice(start, i);
    }
  }
  return code.slice(start);
}

/**
 * The initializer of the nearest plain `const name = value` before `at` whose block still holds `at`. A
 * destructuring, a loop variable and a declaration with no value shadow the name and give none.
 */
function initializerOf(code, name, at) {
  const id = escape(name);
  const declares = new RegExp(
    String.raw`(?<![\w$.])(?:const|let|var)\s+(?:\{[^}]*(?<![\w$])${id}(?![\w$])[^}]*\}|\[[^\]]*(?<![\w$])${id}(?![\w$])[^\]]*\]|${id}(?![\w$]))`,
    "g",
  );
  const plain = new RegExp(String.raw`(?:const|let|var)\s+${id}\s*(?::[^=]+)?=(?!=)\s*`, "y");
  for (const match of [...code.slice(0, at).matchAll(declares)].reverse()) {
    if (!reaches(code, match.index, at)) continue;
    plain.lastIndex = match.index;
    const head = plain.exec(code);
    return head === null ? null : { index: match.index, text: expressionFrom(code, match.index + head[0].length) };
  }
  return null;
}

/**
 * The volatile call an expression stands for, and the const it went through. A name follows to its
 * initializer, and a wrapper, a branch and a wrapping call's arguments are read.
 */
function mintOf(expression, at, context, depth = 0) {
  const text = primaryOf(expression);
  const branches = branchesOf(text);
  if (branches.length !== 1 || branches[0] !== text) {
    for (const branch of branches) {
      const found = mintOf(branch, at, context, depth);
      if (found !== null) return found;
    }
    return null;
  }
  const callee = mintedCall(text, context.volatile);
  if (callee !== null) return { callee, through: null };
  if (!IDENTIFIER.test(text) || depth >= MAX_CHAIN) return null;
  const bound = initializerOf(context.code, text, at);
  const found = bound === null ? null : mintOf(bound.text, bound.index, context, depth + 1);
  return found === null ? null : { callee: found.callee, through: text };
}

/** True when an expression builds a ledger that a throwaway constructor names, directly or through a const. */
function throwawayLedger(expression, at, context, depth = 0) {
  const text = primaryOf(expression);
  if (IDENTIFIER.test(text)) {
    const bound = depth >= MAX_CHAIN ? null : initializerOf(context.code, text, at);
    return bound !== null && throwawayLedger(bound.text, bound.index, context, depth + 1);
  }
  const built = new RegExp(String.raw`^(?:new\s+)?(${CHAIN})\s*(?:<[^>]*>)?\s*\(`).exec(text);
  if (built === null) return false;
  const callee = built[1].replace(/\s+/g, "");
  return context.throwaway.some((name) => callee === name || callee.endsWith(`.${name}`));
}

/**
 * The value text of the property `name` in an object literal, `name` itself for a shorthand, or null. The
 * name is read where strings stay, so a quoted key counts, and the value where they are blanked.
 */
function propertyValue(properties, name, code, literal) {
  const head = new RegExp(String.raw`^\s*(?:${escape(name)}(?![\w$])|"${escape(name)}"|'${escape(name)}')\s*(:?)`);
  for (const { start, end } of properties) {
    const found = head.exec(literal.slice(start, end));
    if (found === null) continue;
    if (found[1] === ":") return code.slice(start + found[0].length, end);
    if (literal.slice(start + found[0].length, end).trim() === "") return name;
  }
  return null;
}

/**
 * @param {{path: string, contents: string}[]} files
 * @param {{runners: string[], key?: string, volatile?: string[], ledgerKey?: string, throwawayLedgers?: string[]}} options
 * `volatile` and the two ledger settings are those of `idempotency`. A runner call whose ledger is a
 * throwaway one is exempt, because nothing outlives it to dedupe against.
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkSagaKey(files, options) {
  const runners = nameList(options?.runners, "sagaKey.runners", { empty: false });
  const key = options.key ?? DEFAULT_KEY;
  if (typeof key !== "string" || key === "") throw new Error(`sagaKey.key must be a property name, got ${JSON.stringify(key)}`);
  const volatile = [...nameList(options.volatile ?? [], "idempotency.volatile", { empty: true }), ...ALWAYS_VOLATILE];
  const ledgerKey = options.ledgerKey ?? DEFAULT_LEDGER_KEY;
  const throwaway = nameList(options.throwawayLedgers ?? [], "idempotency.throwawayLedgers", { empty: true });

  const problems = [];
  for (const { path, contents: source } of files) {
    const code = scrub(source, false);
    const literal = scrub(source, true);
    const context = { code, volatile, throwaway };
    for (const runner of runners) {
      const segments = runner.split(".");
      for (const match of code.matchAll(callPattern(segments.at(-1), segments.slice(0, -1)))) {
        for (const argument of argumentSpans(code, match.index + match[0].length - 1)) {
          const text = code.slice(argument.start, argument.end);
          if (!/^\s*\{/.test(text)) continue;
          const properties = argumentSpans(code, argument.start + text.indexOf("{"));
          const value = propertyValue(properties, key, code, literal);
          const found = value === null ? null : mintOf(value, match.index, context);
          if (found === null) continue;
          const ledger = propertyValue(properties, ledgerKey, code, literal);
          if (ledger !== null && throwawayLedger(ledger, match.index, context)) continue;
          const how = found.through === null ? `${found.callee}()` : `the const ${found.through}, minted by ${found.callee}()`;
          problems.push({
            path,
            rule: "minted-saga-key",
            detail: `line ${code.slice(0, match.index).split("\n").length}: ${runner} takes ${key} from ${how}. A retry mints a second key and runs the saga twice; carry the key from stored state`,
          });
        }
      }
    }
  }
  return problems;
}
