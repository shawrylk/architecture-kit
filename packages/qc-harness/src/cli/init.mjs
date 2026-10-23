// Scaffold what a repository needs before any gate can pass: the config, the git hooks, the CI
// workflow, and an empty decision register. `--full` adds the reference architecture docs and
// the policy of the reference stack. Those docs cite the reference decisions, so they come together.

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { withEnforcementMap } from "../enforcement-map.mjs";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const templates = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../templates");

// Every repository gets these. They judge the change, not the layout.
const CORE = [
  ["githooks/pre-commit", ".githooks/pre-commit"],
  ["githooks/commit-msg", ".githooks/commit-msg"],
  ["githooks/pre-push", ".githooks/pre-push"],
  ["github/workflows/ci.yml", ".github/workflows/ci.yml"],
];

// `--full` only: the reference architecture, its decisions, and its policy. `../decisions.examples.md`
// stays out: it cites ids the shipped register does not define, so it would fail the citations gate.
const FULL = [
  ["quality-thresholds.json", "quality-thresholds.json"],
  [".jscpd.json", ".jscpd.json"],
  ["docs/decisions.md", "docs/decisions.md"],
  ["docs/architecture.md", "docs/architecture.md"],
  ["docs/enforcement.md", "docs/enforcement.md"],
  ["docs/guards.md", "docs/guards.md"],
  ["docs/performance.md", "docs/performance.md"],
  ["docs/pagination.md", "docs/pagination.md"],
  ["docs/glossary.md", "docs/glossary.md"],
  ["docs/ui.md", "docs/ui.md"],
  ["github/workflows/pr-policy.yml", ".github/workflows/pr-policy.yml"],
  // The prose style `qc prose` hands to Vale: one config and one file per rule.
  ["vale/.vale.ini", ".vale/.vale.ini"],
  ...readdirSync(path.join(templates, "vale/styles/Qc")).map((rule) => [`vale/styles/Qc/${rule}`, `.vale/styles/Qc/${rule}`]),
];

const EMPTY_REGISTER = `# Decisions

Every id cited in this repository's code or docs is defined here. A citation to an id that is
not listed fails the citations gate. Ids are stable: never renumber one.

| id | decision | the rule it imposes |
|---|---|---|
`;

// Folders that hold no source of the repository's own.
const SKIP = new Set(["node_modules", "dist", "build", "out", "coverage", "vendor"]);

/** Every folder named `featureDir` within four levels of the root, as a POSIX path. None found is an empty list. */
export function detectFeatureRoots(root, featureDir) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === featureDir) found.push(path.relative(root, full).split(path.sep).join("/"));
      else if (depth < 4) walk(full, depth + 1);
    }
  };
  walk(root, 1);
  return found.sort();
}

async function writeIfAbsent(to, text, force) {
  if (existsSync(to) && !force) return { to, status: "kept" };
  const overwriting = existsSync(to);
  await mkdir(path.dirname(to), { recursive: true });
  await writeFile(to, text);
  return { to, status: overwriting ? "overwritten" : "written" };
}

// The enforcement map is filled in on the way out, so a rule added to the kit cannot ship a
// template that fails the kit's own enforcement-map gate.
async function copyTemplate(from, to, force, config) {
  if (existsSync(to) && !force) return { to, status: "kept" };
  await mkdir(path.dirname(to), { recursive: true });
  const overwriting = existsSync(to);
  if (to.endsWith(config.docs.enforcement.split("/").pop())) {
    await writeFile(to, withEnforcementMap(await readFile(from, "utf8"), config));
  } else {
    await copyFile(from, to);
  }
  return { to, status: overwriting && force ? "overwritten" : "written" };
}

const SCRIPTS = {
  "spec:check": "qc check",
  prepare: "qc install-hooks",
};

/** Add the scripts the docs reference, without touching one the repository already set. */
async function addScripts(config) {
  const file = path.join(config.root, "package.json");
  if (!existsSync(file)) return [];
  const manifest = JSON.parse(await readFile(file, "utf8"));
  const scripts = manifest.scripts ?? {};
  const added = Object.entries(SCRIPTS).filter(([name]) => scripts[name] === undefined);
  if (added.length === 0) return [{ to: file, status: "kept" }];
  manifest.scripts = { ...scripts, ...Object.fromEntries(added) };
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return [{ to: file, status: "written" }];
}

/** Adds the worktree folder to `.gitignore` unless a line already names it, so no worktree shows in `git status`. QC-015. */
async function ignoreWorktrees(config) {
  const file = path.join(config.root, ".gitignore");
  const dir = config.worktree.dir.replace(/\/+$/, "");
  const text = existsSync(file) ? await readFile(file, "utf8") : "";
  const spellings = new Set([dir, `${dir}/`, `/${dir}`, `/${dir}/`]);
  if (text.split(/\r?\n/).some((line) => spellings.has(line.trim()))) return { to: file, status: "kept" };
  await writeFile(file, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${dir}/\n`);
  return { to: file, status: "written" };
}

export async function runInit(config, args = []) {
  const force = args.includes("--force");
  const full = args.includes("--full");
  const results = [];

  // The roots this repository has, not the reference layout: a root that matches nothing fails `qc check`.
  const featureRoots = detectFeatureRoots(config.root, config.featureDir);
  const qcConfig = { $comment: "Every key is optional. `qc config` prints what is in force.", featureRoots, foreign: [], agreements: [] };
  results.push(await writeIfAbsent(path.join(config.root, "qc.config.json"), `${JSON.stringify(qcConfig, null, 2)}\n`, force));

  for (const [source, target] of [...CORE, ...(full ? FULL : [])]) {
    results.push(await copyTemplate(path.join(templates, source), path.join(config.root, target), force, config));
  }
  if (!full) results.push(await writeIfAbsent(path.join(config.root, config.docs.decisions), EMPTY_REGISTER, force));

  for (const name of ["pre-commit", "commit-msg", "pre-push"]) {
    const hook = path.join(config.root, ".githooks", name);
    if (existsSync(hook)) await writeFile(hook, await readFile(hook, "utf8"), { mode: 0o755 });
  }

  results.push(...(await addScripts(config)));
  results.push(await ignoreWorktrees(config));

  for (const { to, status } of results) {
    console.log(`${status.padEnd(11)} ${path.relative(config.root, to)}`);
  }

  const kept = results.filter((result) => result.status === "kept").length;
  if (kept > 0) console.log(`\n${kept} file(s) already existed and were left alone. --force overwrites.`);
  console.log(`
featureRoots: ${featureRoots.length > 0 ? featureRoots.join(", ") : "none found, so no feature gate runs"}.
Next:
  1. \`qc install-hooks\` to bind the pre-commit, commit-msg, and pre-push hooks.
  2. \`qc check\`, \`qc typecheck\`, and \`qc lint\` to see the gates pass.${full ? "" : `
  3. \`qc init --full\` adds the reference architecture docs, their decisions, and the PR policy workflow.`}`);
}
