// The resource for a work order's declaration: the gitignored manifest in the project root that
// names the paths and the branch the work order owns. Both edit guards read it through here.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const MANIFEST_FILE = ".claude/work-order.local.json";

/** @returns the parsed manifest, or null when the project declares no work order. */
export function readManifest(root) {
  const file = path.join(root, MANIFEST_FILE);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}
