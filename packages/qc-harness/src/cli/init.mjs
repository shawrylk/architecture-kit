// Scaffold the documents and configuration a new repository needs before any gate
// can pass. The citations gate reads docs/decisions.md; without it, gate one fails
// on every file. So `init` is not a convenience — it is the gate's own precondition.

import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { withEnforcementMap } from "../enforcement-map.mjs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const templates = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../templates");

// Copied into the repository root. `../decisions.examples.md` sits outside this list on
// purpose: it cites ids the shipped register does not define, so a repository that took it
// would fail the citations gate. A new
// repository should not carry somebody else's domain decisions.
const FILES = [
  ["qc.config.json", "qc.config.json"],
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
  ["githooks/pre-commit", ".githooks/pre-commit"],
  ["githooks/pre-push", ".githooks/pre-push"],
  ["github/workflows/ci.yml", ".github/workflows/ci.yml"],
];

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
  "gen:feature": "qc feature",
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

export async function runInit(config, args = []) {
  const force = args.includes("--force");
  const results = [];
  for (const [source, target] of FILES) {
    results.push(await copyTemplate(path.join(templates, source), path.join(config.root, target), force, config));
  }

  for (const name of ["pre-commit", "pre-push"]) {
    const hook = path.join(config.root, ".githooks", name);
    if (existsSync(hook)) await writeFile(hook, await readFile(hook, "utf8"), { mode: 0o755 });
  }

  // The docs and the CI workflow both tell a reader to run these, so `init` puts them
  // where a reader will look rather than leaving the instruction dangling.
  results.push(...(await addScripts(config)));

  for (const { to, status } of results) {
    console.log(`${status.padEnd(11)} ${path.relative(config.root, to)}`);
  }

  const kept = results.filter((result) => result.status === "kept").length;
  if (kept > 0) console.log(`\n${kept} file(s) already existed and were left alone. --force overwrites.`);
  console.log(`
Next:
  1. Edit docs/decisions.md — delete what does not apply, add your own. Ids are stable;
     never renumber, because every citation points at a number.
  2. Edit docs/glossary.md and the per-surface table in docs/performance.md.
  3. Point qc.config.json at your layout if it differs from the reference. \`qc config\`
     prints what is in force — featureRoots matching nothing is a failed check, not a pass.
  4. \`qc install-hooks\` to bind the pre-commit and pre-push hooks.
  5. \`qc feature <domain-name>\` to scaffold the first slice, then \`qc check\`.`);
}
