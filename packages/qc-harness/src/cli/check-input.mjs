// The file list for `qc check`, from arguments and from `--files-from <path|->` (NUL-separated).
// A list read from a stream has no length limit, unlike the command line of `npx.cmd`.

import { readFile } from "node:fs/promises";
import process from "node:process";

/** @returns {Promise<{ files: string[], listed: boolean }>} `listed` is true when `--files-from` was given. */
export async function checkFiles(args) {
  const files = [];
  let source;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--files-from") source = args[++i] ?? "-";
    else files.push(args[i]);
  }
  if (source === undefined) return { files, listed: false };
  const text = source === "-" ? await readStdin() : await readFile(source, "utf8");
  return { files: [...files, ...text.split("\0").filter(Boolean)], listed: true };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
