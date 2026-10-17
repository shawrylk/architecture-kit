// A fragment: the TypeScript compiler API, loaded from the repository being judged, so the harness adds
// no runtime dependency. The kit's own copy is the fallback when the repository holds none.

import { createRequire } from "node:module";
import path from "node:path";

const cache = new Map();

/** @returns the `typescript` module, or null when neither the repository nor the kit resolves it. */
export function loadTypeScript(root = process.cwd()) {
  if (cache.has(root)) return cache.get(root);
  let found = null;
  for (const from of [path.join(root, "noop.js"), import.meta.url]) {
    try {
      found = createRequire(from)("typescript");
      break;
    } catch {
      // Try the next place to resolve it from.
    }
  }
  cache.set(root, found);
  return found;
}

/** The syntax tree of one `.ts` or `.tsx` source. */
export function parseSource(ts, name, text) {
  const kind = name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, kind);
}
