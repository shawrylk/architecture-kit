// `qc decisions` — where every id is cited, and how to renumber one without breaking a citation.

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { definedIds } from "../gates/citations.mjs";
import { gateDescriptions } from "../descriptions.mjs";
import { rules as lintRules } from "../eslint/index.mjs";
import { enabled } from "../config.mjs";
import {
  audit,
  citationsIn,
  isBareId,
  isImmutable,
  parseRegister,
  planProblems,
  registerProblems,
  renamePlan,
  rewrite,
  squashPlan,
} from "../decisions.mjs";

const run = promisify(execFile);

// Generated output is rewritten from its own input, so a rename there is undone by the next run.
const GENERATED = /\.generated\.[^.]+$/;
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|woff2?|ttf|lock)$/i;

export const USAGE = `qc decisions — where every decision id is cited, and how to renumber one

  qc decisions                what is cited where, and what is wrong with the register
  qc decisions ADR-0054       every citation of one id, with its line
  qc decisions --check        exit 1 on a gap, an uncited id, or an undefined one
  qc decisions --audit        which decisions earn their id, which merge, which are already a check
  qc decisions --squash       close every gap: rewrite the register and every citation
  qc decisions --rename A=B,C=D

  --dry-run  print what would change and write nothing
  --force    run against a dirty tree`;

// Tracked and untracked-but-not-ignored, so this sees what the citations gate sees.
async function tracked(root) {
  const args = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
  const { stdout } = await run("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return [...new Set(stdout.split("\0"))].filter((name) => name !== "" && !BINARY.test(name));
}

async function scan(config) {
  const prefixes = config.citations.prefixes;
  const exclude = config.decisions.exclude ?? [];
  const sites = new Map();
  const generated = new Map();
  for (const file of await tracked(config.root)) {
    // A vendored tool cites its own upstream register, never this repository's.
    if (exclude.some((source) => new RegExp(source).test(file))) continue;
    const contents = await readFile(path.join(config.root, file), "utf8").catch(() => null);
    if (contents === null) continue;
    const target = GENERATED.test(file) ? generated : sites;
    for (const found of citationsIn(contents, prefixes)) {
      const at = target.get(found.id) ?? [];
      at.push({ file, line: found.line, text: found.text });
      target.set(found.id, at);
    }
  }
  const register = await readFile(path.join(config.root, config.docs.decisions), "utf8");
  return { sites, generated, defined: definedIds(register, { prefixes }), rows: parseRegister(register, prefixes) };
}

async function apply(config, plan, sites) {
  const cited = new Set();
  for (const [from] of plan) for (const site of sites.get(from) ?? []) cited.add(site.file);
  const immutable = config.decisions.immutable;
  const refused = [...cited].filter((file) => isImmutable(file, immutable)).sort();
  const touched = new Set([...cited].filter((file) => !isImmutable(file, immutable)));
  for (const file of [...touched].sort()) {
    const full = path.join(config.root, file);
    await writeFile(full, rewrite(await readFile(full, "utf8"), plan));
  }
  return { touched, refused };
}

// A hashed file's bytes are its identity, so the stale id stays and a person decides what to do about it.
function reportRefused(refused) {
  if (refused.length === 0) return;
  console.log(`\n  ${refused.length} content-addressed file(s) cite a renumbered id and were NOT rewritten:`);
  for (const file of refused) console.log(`    ${file}`);
  console.log("  Editing one invalidates the checksum its ledger recorded. Leave the id, or re-ledger deliberately.");
}

function usesOf(sites, id, decisionsPath) {
  return (sites.get(id) ?? []).filter((site) => site.file !== decisionsPath);
}

const VERDICT = {
  keep: "cited across more than one area",
  "local?": "one area cites it — that area's doc may be its home",
  "inline?": "one file cites it — that file's own line may be its home",
  "abort?": "nothing cites it",
};

function checksOf(config) {
  return [
    ...Object.entries(lintRules)
      .filter(([name]) => enabled(config.rules, name))
      .map(([name, rule]) => ({ name: `qc/${name}`, description: rule.meta.docs.description })),
    ...Object.keys(config.gates)
      .filter((name) => enabled(config.gates, name))
      .map((name) => ({ name: `qc check (${name})`, description: gateDescriptions[name] })),
  ];
}

function printAudit(rows, sites, decisionsPath, config) {
  const { verdicts, merges, checked } = audit(rows, sites, decisionsPath, checksOf(config));
  const order = ["abort?", "inline?", "local?", "keep"];
  console.log(`${rows.length} decision(s)\n`);
  for (const name of order) {
    const group = verdicts.filter((entry) => entry.verdict === name);
    if (group.length === 0) continue;
    console.log(`${name}  ${VERDICT[name]}`);
    for (const entry of group) {
      const where = entry.areas.length > 0 ? entry.areas.slice(0, 4).join(", ") : "—";
      console.log(`  ${entry.id}  ${String(entry.files).padStart(4)} file(s)  ${where}`);
      console.log(`            ${entry.decision.slice(0, 96)}`);
    }
    console.log("");
  }
  if (merges.length > 0) {
    console.log("merge?  two decisions saying much the same thing");
    for (const pair of merges) {
      console.log(`  ${pair.left} + ${pair.right}  ${(pair.score * 100).toFixed(0)}%  ${pair.shared.slice(0, 8).join(" ")}`);
    }
    console.log("");
  }
  if (checked.length > 0) {
    console.log("already a check  the rule is stated here and in the generated enforcement map");
    for (const hit of checked) console.log(`  ${hit.id}  ${hit.check}  ${(hit.score * 100).toFixed(0)}%`);
    console.log("");
  }
  console.log("Every verdict is a prompt, not a finding. A decision enforced by absence is cited by nothing.");
}

export async function runDecisions(config, args) {
  const flag = (name) => args.includes(name);
  const value = (name) => (args.indexOf(name) === -1 ? undefined : args[args.indexOf(name) + 1]);
  if (flag("--help")) {
    console.log(USAGE);
    return 0;
  }

  const { sites, generated, defined, rows } = await scan(config);
  const decisionsPath = config.docs.decisions;

  if (flag("--audit")) {
    printAudit(rows, sites, decisionsPath, config);
    return 0;
  }

  const one = args.find((arg) => isBareId(arg, config.citations.prefixes));
  if (one) {
    const uses = sites.get(one) ?? [];
    console.log(`${one} — ${uses.length} citation(s)${defined.has(one) ? "" : "  [NOT DEFINED]"}`);
    for (const site of uses) console.log(`  ${site.file}:${site.line}  ${site.text.slice(0, 110)}`);
    for (const site of generated.get(one) ?? []) console.log(`  (generated) ${site.file}:${site.line}`);
    return 0;
  }

  const plan = flag("--squash")
    ? squashPlan(defined)
    : value("--rename")
      ? renamePlan(value("--rename"))
      : null;

  if (plan === null) {
    const problems = registerProblems(defined, sites, decisionsPath);
    const rows = [...defined]
      .map((id) => ({ id, uses: usesOf(sites, id, decisionsPath).length }))
      .sort((a, b) => b.uses - a.uses || a.id.localeCompare(b.id));
    console.log(`${defined.size} decision(s), ${rows.reduce((sum, row) => sum + row.uses, 0)} citation(s)\n`);
    for (const row of rows) console.log(`  ${row.id}  ${String(row.uses).padStart(4)}`);
    if (problems.length > 0) {
      console.log("");
      for (const problem of problems) console.log(`  ${problem.fatal ? "!" : "-"} ${problem.text}`);
    }
    return flag("--check") && problems.some((problem) => problem.fatal) ? 1 : 0;
  }

  const refusals = planProblems(plan, defined);
  if (refusals.length > 0) {
    for (const refusal of refusals) console.error(`FAIL decisions    ${refusal}`);
    return 1;
  }
  if (plan.size === 0) {
    console.log("OK  decisions     no gaps to close");
    return 0;
  }
  if (!flag("--force") && !flag("--dry-run")) {
    const { stdout } = await run("git", ["status", "--porcelain"], { cwd: config.root });
    if (stdout.trim() !== "") {
      console.error("FAIL decisions    dirty tree. This touches many files at once; commit or stash");
      console.error("                  first so it stays one revertible change. --force overrides.");
      return 1;
    }
  }

  for (const [from, to] of plan) console.log(`  ${from} -> ${to}   ${(sites.get(from) ?? []).length} citation(s)`);
  const stale = [...plan.keys()].filter((from) => generated.has(from));
  if (stale.length > 0) console.log(`\n  also in generated output: ${stale.join(", ")} — regenerate after this`);

  if (flag("--dry-run")) {
    const files = new Set();
    for (const [from] of plan) for (const site of sites.get(from) ?? []) files.add(site.file);
    const held = [...files].filter((file) => isImmutable(file, config.decisions.immutable));
    console.log(`\n  ${files.size - held.length} file(s) would change. Nothing written.`);
    reportRefused(held);
    return 0;
  }

  const { touched, refused } = await apply(config, plan, sites);
  console.log(`\nOK  decisions     ${plan.size} id(s) renumbered across ${touched.size} file(s)`);
  reportRefused(refused);
  return 0;
}
