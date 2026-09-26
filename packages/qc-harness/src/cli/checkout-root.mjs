// A fragment that finds a checkout's top level with no git process, for hooks that run on every
// call. `.git` is a folder in a primary checkout and a file in a linked worktree.

import { existsSync } from "node:fs";
import path from "node:path";

/** @returns the nearest folder at or above `dir` that holds `.git`, or null when none does. */
export function checkoutRootOf(dir, exists = existsSync) {
  let current = path.resolve(dir);
  for (;;) {
    if (exists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
