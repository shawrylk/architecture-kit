// A resource: the one list of a repository's files. Every gate and `qc decisions` read it, so a
// path git ignores is invisible to all of them, and one `qc check` spawns git once.

import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { globToRegExp } from "../glob.mjs";

const execFileAsync = promisify(execFile);
// The execFile default is 1 MB. A 30,000-file repository lists about 2 MB of paths.
const MAX_BUFFER = 256 * 1024 * 1024;

/** A leading `**` also matches at the root, as ESLint reads the same `ignores`. */
function ignoredBy(globs) {
  const patterns = globs.map(globToRegExp);
  return (rel) => patterns.some((pattern) => pattern.test(rel) || pattern.test(`/${rel}`));
}

/** @returns {Promise<string[] | null>} null when `root` is in no git work tree */
async function gitListing(root, pathspecs) {
  const args = ["--literal-pathspecs", "ls-files", "-z", "--cached", "--others", "--exclude-standard"];
  if (pathspecs) args.push("--", ...pathspecs);
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: root, maxBuffer: MAX_BUFFER });
    return stdout.split("\0");
  } catch {
    return null;
  }
}

/** The walk outside git: every file, with `.git` and each ignored folder pruned. */
async function walkListing(root, pathspecs, ignored) {
  const files = [];
  async function visit(rel) {
    for (const entry of await readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (!entry.isDirectory()) files.push(child);
      else if (entry.name !== ".git" && !ignored(`${child}/`)) await visit(child);
    }
  }
  if (!pathspecs) await visit("");
  for (const spec of pathspecs ?? []) {
    const found = await stat(path.join(root, spec)).catch(() => null);
    if (found?.isDirectory()) await visit(spec);
    else if (found) files.push(spec);
  }
  return files;
}

/**
 * Tracked files and untracked files git does not ignore, then minus `ignores`.
 * @param {string} root the repository root that `qc.config.json` sits in
 * @param {{ignores?: string[], pathspecs?: string[]}} [options] pathspecs are literal, relative to `root`
 * @returns {Promise<string[]>} forward-slash paths relative to `root`, sorted
 */
export async function repoFiles(root, { ignores = [], pathspecs } = {}) {
  if (pathspecs?.length === 0) return [];
  const ignored = ignoredBy(ignores);
  const listed = (await gitListing(root, pathspecs)) ?? (await walkListing(root, pathspecs, ignored));
  // A trailing slash is an untracked nested repository, which git lists as one entry.
  const files = listed.filter((file) => file !== "" && !file.endsWith("/") && !ignored(file));
  return [...new Set(files)].sort();
}
