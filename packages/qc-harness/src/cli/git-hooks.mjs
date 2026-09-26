// The git hooks are the gates a human commit passes. A hook that drifts from the kit's template
// skips a step and nothing says so, so this reads the hooks and names each required call they lack.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const TRACKED = ".githooks";

function gitOutput(root, ...args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/**
 * @returns the folder git runs hooks from, and whether a missing hook there is drift. A folder
 *   named by core.hooksPath, or the tracked `.githooks` every clone installs, must hold each hook.
 *   Git's own hooks folder is local to one clone, so a hook missing there is only not installed.
 */
export function hookFolder(root) {
  const configured = gitOutput(root, "config", "--get", "core.hooksPath");
  if (configured) return { dir: path.resolve(root, configured), strict: true };
  if (existsSync(path.join(root, TRACKED))) return { dir: path.join(root, TRACKED), strict: true };
  const local = gitOutput(root, "rev-parse", "--git-path", "hooks");
  return local ? { dir: path.resolve(root, local), strict: false } : null;
}

/** The hook's text without its comment lines, so a commented-out call is no call. */
const liveText = (text) =>
  text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

/**
 * @param {string} root the repository root
 * @param {Record<string, string[]>} required each hook name, and the calls it must make
 * @returns {{problems: {path: string, rule: string, detail: string}[], notes: string[]}}
 */
export function hookDrift(root, required) {
  const problems = [];
  const notes = [];
  const folder = hookFolder(root);
  if (!folder) return { problems, notes: ["no git checkout, so no hooks to read"] };

  for (const [name, calls] of Object.entries(required)) {
    if (calls.length === 0) continue;
    const file = path.join(folder.dir, name);
    const shown = path.relative(root, file).split(path.sep).join("/");
    if (!existsSync(file)) {
      if (folder.strict) {
        problems.push({ path: shown, rule: "hook-drift", detail: `${name} is missing, so its steps never run. Copy it from the kit's templates/githooks.` });
      } else {
        notes.push(`${name} is not installed at ${shown}. Run \`qc install-hooks\`.`);
      }
      continue;
    }
    const text = liveText(readFileSync(file, "utf8"));
    for (const call of calls.filter((expected) => !text.includes(expected))) {
      problems.push({ path: shown, rule: "hook-drift", detail: `${name} never calls \`${call}\`, so that step is off. Add it, as the kit's templates/githooks/${name} does.` });
    }
  }
  return { problems, notes };
}
