#!/usr/bin/env node
// The PreToolUse trigger that names the components a new component file may duplicate. It runs on a `Write`
// of a `.tsx` file that does not exist yet and lies under the component roots, ranks the catalog by the
// words of the file name and the exported names in the content, and adds context. It never blocks.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE, load } from "../config.mjs";
import { findComponents } from "../ui/find.mjs";
import { componentFileMatcher, uiOptions } from "../ui/options.mjs";
import { scanComponents } from "../ui/scan.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";

const TOP = 5;
const EXPORTED = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|const|class)\s+([A-Z]\w*)/g;
const EXPORT_LIST = /\bexport\s*\{([^}]*)\}/g;

const context = (text) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } });

/** The names a new file exports: declared with `export`, or listed in an `export { }`. */
export function exportedNames(content) {
  const names = [...content.matchAll(EXPORTED)].map((found) => found[1]);
  for (const list of content.matchAll(EXPORT_LIST)) {
    for (const item of list[1].split(",")) {
      const name = item.trim().split(/\s+as\s+/).at(-1);
      if (name && /^[A-Z]\w*$/.test(name)) names.push(name);
    }
  }
  return [...new Set(names)];
}

/** The nearest folder that exists, since a new file may sit in a folder nobody has made yet. */
function existingAncestor(dir) {
  let here = dir;
  while (!existsSync(here) && path.dirname(here) !== here) here = path.dirname(here);
  return here;
}

/** The hook output for one call, or null to let it run with no message. */
export async function decide(call) {
  const input = call.tool_input ?? {};
  if (call.tool_name !== "Write" || typeof input.file_path !== "string" || !input.file_path.endsWith(".tsx")) return null;
  const file = path.resolve(call.cwd ?? process.cwd(), input.file_path);
  if (existsSync(file)) return null;
  const root = checkoutRootOf(existingAncestor(path.dirname(file)));
  if (!root || !existsSync(path.join(root, CONFIG_FILE))) return null;

  const rel = path.relative(root, file).split(path.sep).join("/");
  let config;
  try {
    config = load(root);
  } catch {
    return null;
  }
  if (!componentFileMatcher(uiOptions(config))(rel)) return null;

  const words = [path.basename(file, ".tsx"), ...exportedNames(String(input.content ?? ""))];
  let entries;
  try {
    ({ entries } = await scanComponents(config));
  } catch {
    return null;
  }
  const found = findComponents(entries, words, TOP);
  if (found.length === 0) return null;
  const list = found.map(({ entry }) => `${entry.name} (${entry.path})`).join(", ");
  return context(
    `Existing components that may already do this: ${list}. Reuse or extend one; write a new one only when none fits, and say why in its JSDoc.`,
  );
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const isEntryPoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntryPoint) {
  let call = null;
  try {
    call = JSON.parse(await readStdin());
  } catch {
    // Not hook input, so there is nothing to judge.
  }
  const output = call ? await decide(call).catch(() => null) : null;
  if (output) process.stdout.write(JSON.stringify(output));
}
