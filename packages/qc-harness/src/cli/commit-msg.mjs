// A commit message is conventional, English, and carries the attribution trailer when a team asks
// for one. The conventional rules are commitlint's, loaded from the repository's own node_modules,
// so the harness gains no runtime dependency and no rule set of its own.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { scriptPattern } from "../gates/english-source.mjs";

export const INSTALL_HINT = "pnpm add -D @commitlint/lint @commitlint/config-conventional";
const TRAILER = /^co-authored-by:\s*\S/im;

const importPath = async (file) => (await import(pathToFileURL(file).href)).default;

/** @returns the ESM entry of a package installed beside a file, which require.resolve cannot read from an import-only exports map. */
function importEntry(fromFile, name) {
  for (let dir = path.dirname(fromFile); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    const manifest = path.join(dir, "node_modules", name, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    let entry = pkg.exports?.["."] ?? pkg.exports ?? pkg.main ?? "index.js";
    while (typeof entry === "object" && entry !== null) entry = entry.import ?? entry.default;
    return path.join(path.dirname(manifest), entry);
  }
  return null;
}

/** The parser options of the config's preset, so `feat!:` parses. Undefined keeps commitlint's default parser. */
async function parserOptions(configPath, preset) {
  if (typeof preset !== "string") return preset?.parserOpts;
  const entry = importEntry(configPath, preset);
  if (!entry) return undefined;
  const created = await (await importPath(entry))();
  return created.parser ?? created.parserOpts;
}

/** @returns commitlint's lint function and the conventional config from the repository, or null when either is missing. */
export async function loadCommitlint(root) {
  const require = createRequire(path.join(root, "package.json"));
  let lintPath;
  let configPath;
  try {
    lintPath = require.resolve("@commitlint/lint");
    configPath = require.resolve("@commitlint/config-conventional");
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") return null;
    throw error;
  }
  const config = await importPath(configPath);
  return { lint: await importPath(lintPath), rules: config.rules, parserOpts: await parserOptions(configPath, config.parserPreset) };
}

/**
 * @param {string} raw the message file as git wrote it
 * @param {{conventional?: boolean, attribution?: boolean, scripts?: string[]}} options
 * @param {{lint: Function, rules: object, parserOpts?: object} | null} commitlint
 * @returns {Promise<{rule: string, detail: string}[]>}
 */
export async function checkCommitMessage(raw, options, commitlint) {
  const message = raw
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim();
  const problems = [];
  if (options.conventional !== false) {
    if (commitlint) {
      const report = await commitlint.lint(message, commitlint.rules, commitlint.parserOpts ? { parserOpts: commitlint.parserOpts } : {});
      for (const error of report.errors) problems.push({ rule: `conventional/${error.name}`, detail: error.message });
    } else {
      problems.push({
        rule: "commitlint-missing",
        detail: `commitlint is not installed here. Run \`${INSTALL_HINT}\`, or set commitMessage.conventional to false.`,
      });
    }
  }
  const script = scriptPattern(options.scripts ?? ["cjk"]);
  message.split("\n").forEach((line, index) => {
    if (script.test(line)) problems.push({ rule: "english", detail: `line ${index + 1} is not English. A commit message is English.` });
  });
  if (options.attribution === true && !TRAILER.test(message)) {
    problems.push({ rule: "attribution", detail: "the message has no Co-Authored-By trailer, and commitMessage.attribution requires one." });
  }
  return problems;
}

export async function runCommitMsg(config, file) {
  const options = { ...config.commitMessage, scripts: config.language?.scripts };
  const commitlint = options.conventional === false ? null : await loadCommitlint(config.root);
  const problems = await checkCommitMessage(readFileSync(file, "utf8"), options, commitlint);
  for (const problem of problems) console.error(`FAIL  commit-msg  ${problem.rule}: ${problem.detail}`);
  return problems.length > 0 ? 1 : 0;
}
