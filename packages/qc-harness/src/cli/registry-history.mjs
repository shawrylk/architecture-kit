// A resource: the thresholds registry at the merge base with a ref, the registry now, and the ADR
// files the change touches. Git answers each question; no answer is a reason to skip, never a failure.

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { globMatcher } from "../glob.mjs";

/** @returns {string|null} stdout, or null when git is absent or the command fails. */
function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return result.status === 0 ? result.stdout : null;
}

function gatesOf(text) {
  if (text === null) return {};
  try {
    return JSON.parse(text).gates ?? {};
  } catch {
    return {};
  }
}

const paths = (listing) => (listing ?? "").split("\0").filter(Boolean);

/**
 * @param {string} root  the repository root, or a folder inside one
 * @param {{base: string, registry: string, adrGlobs: string[]}} options
 * @returns {Promise<{skip: string} | {before: object, after: object, adrs: {path: string, text: string}[]}>}
 */
export async function ratchetInputs(root, { base, registry, adrGlobs }) {
  if (git(root, "rev-parse", "--verify", "--quiet", "HEAD") === null) return { skip: "no git, or no commit yet" };
  if (git(root, "rev-parse", "--verify", "--quiet", `${base}^{commit}`) === null) return { skip: `no ref '${base}'` };
  const mergeBase = git(root, "merge-base", base, "HEAD")?.trim();
  if (!mergeBase) return { skip: `no merge base with '${base}', as in a shallow clone` };

  const file = registry.split(path.sep).join("/");
  const before = gatesOf(git(root, "show", `${mergeBase}:./${file}`));
  const after = gatesOf(await readFile(path.join(root, registry), "utf8").catch(() => null));

  // Committed, staged and unstaged changes since the merge base, and a new file not yet added.
  const isAdr = globMatcher(adrGlobs);
  const changed = new Set([
    ...paths(git(root, "diff", "--name-only", "--relative", "-z", mergeBase)),
    ...paths(git(root, "ls-files", "--others", "--exclude-standard", "-z")),
  ]);
  const adrs = [];
  for (const rel of [...changed].filter((rel) => rel.endsWith(".md") && isAdr(rel))) {
    const text = await readFile(path.join(root, rel), "utf8").catch(() => null);
    if (text !== null) adrs.push({ path: rel, text });
  }
  return { before, after, adrs };
}
