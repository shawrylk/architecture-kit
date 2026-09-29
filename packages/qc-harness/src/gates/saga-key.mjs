// A saga resumes on its key. A runner that receives a key minted at the call starts a second saga
// on every retry, so the write that the key guards runs twice. The key must come from stored
// state, and the runner's argument is where a call site can be read for it.
// docs/guards.md.
//
// It reads a runner's object-literal argument only. A runner that takes the key as a positional
// argument, and a key built inside a helper the call does not name, are not read.

import { callArguments, callPattern, declarationOf, escape } from "./call-args.mjs";

const DEFAULT_KEY = "mutationId";
// `idempotency.volatile` lists the names a key must not be built from, and the runner passes it in.
// `uuid.v4` is the qualified form of a source that list names as `uuid`, so it always counts.
const DEFAULT_VOLATILE = ["Date.now", "Math.random", "crypto.randomUUID", "uuid", "uuidv4", "nanoid", "randomUUID"];
const ALWAYS_VOLATILE = ["uuid.v4"];

const CALLEE = /^(?:await\s+)?([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?:<[^>]*>)?\s*\(/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function names(value, what) {
  if (!Array.isArray(value) || value.length === 0 || value.some((name) => typeof name !== "string" || name === "")) {
    throw new Error(`${what} must be a non-empty list of names, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** The volatile name a value starts as a call to, matched at its tail: `crypto.randomUUID()` and `randomUUID()` both. */
function mintedBy(value, volatile) {
  const callee = CALLEE.exec(value.trim())?.[1].replace(/\s+/g, "");
  if (callee === undefined) return null;
  return volatile.find((name) => callee === name || callee.endsWith(`.${name}`)) === undefined ? null : callee;
}

/** The value of the `key` property of an object literal: shorthand yields the key itself, no property yields null. */
function propertyOf(argument, key) {
  const shape = new RegExp(String.raw`^\s*(?:${escape(key)}|"${escape(key)}"|'${escape(key)}')\s*(?::([\s\S]*))?$`);
  for (const property of callArguments(argument, 0)) {
    const match = shape.exec(property);
    if (match) return match[1] === undefined ? key : match[1].trim();
  }
  return null;
}

/** The initializer of a plain `const name = value`. A destructuring or a parameter has none to read. */
function initializerOf(source, name, from, callAt) {
  const declaration = declarationOf(source, name, from, callAt);
  return new RegExp(String.raw`^(?:export\s+)?(?:const|let|var)\s+${escape(name)}\s*(?::[^=]+)?=\s*([\s\S]*)`).exec(declaration)?.[1] ?? null;
}

/** True when the call sits in a `//` line or in a block comment's margin. */
function commented(source, at) {
  const line = source.slice(source.lastIndexOf("\n", at - 1) + 1, at).trimStart();
  return line.startsWith("//") || line.startsWith("*") || line.startsWith("/*");
}

/**
 * @param {{path: string, contents: string}[]} files
 * @param {{runners: string[], key?: string, volatile?: string[]}} options
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkSagaKey(files, options) {
  const runners = names(options?.runners, "sagaKey.runners");
  const key = options.key ?? DEFAULT_KEY;
  if (typeof key !== "string" || key === "") throw new Error(`sagaKey.key must be a property name, got ${JSON.stringify(key)}`);
  const volatile = [...names(options.volatile ?? DEFAULT_VOLATILE, "idempotency.volatile"), ...ALWAYS_VOLATILE];

  const problems = [];
  for (const { path, contents: source } of files) {
    for (const runner of runners) {
      const segments = runner.split(".");
      const pattern = callPattern(segments.at(-1), segments.slice(0, -1));
      for (const match of source.matchAll(pattern)) {
        if (commented(source, match.index)) continue;
        // The enclosing function starts the window, so a neighbour's const cannot stand for this call's.
        const before = source.slice(0, match.index);
        const from = Math.max(0, before.lastIndexOf("function "), before.lastIndexOf("=> {"), before.lastIndexOf("\n}"));
        for (const argument of callArguments(source, match.index + match[0].length - 1)) {
          if (!argument.trim().startsWith("{")) continue;
          const value = propertyOf(argument.trim(), key);
          if (value === null) continue;
          const direct = mintedBy(value, volatile);
          const initializer = direct === null && IDENTIFIER.test(value) ? initializerOf(source, value, from, match.index) : null;
          const through = initializer === null ? null : mintedBy(initializer, volatile);
          const minted = direct ?? through;
          if (minted === null) continue;
          const how = direct === null ? `the const ${value}, minted by ${minted}()` : `${minted}()`;
          problems.push({
            path,
            rule: "minted-saga-key",
            detail: `line ${before.split("\n").length}: ${runner} takes ${key} from ${how}. A retry mints a second key and runs the saga twice; carry the key from stored state`,
          });
        }
      }
    }
  }
  return problems;
}
