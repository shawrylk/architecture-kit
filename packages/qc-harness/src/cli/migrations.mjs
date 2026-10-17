// `qc migrations renumber`: moves a branch's migrations after the last one of another ref, so two branches
// that took the same number merge with no duplicate and no gap.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

export const USAGE = `qc migrations — keep migration numbers unique across branches

  qc migrations renumber --onto <ref> [--branch <ref>]
      rename the migrations <branch> added since its merge base with <ref> to follow the last
      migration of <ref>, in order, and rewrite each reference to an old name in the tracked files.
      <branch> is HEAD by default; during a merge, pass --onto HEAD --branch MERGE_HEAD.`;

const MIGRATION = /^(\d+)_(.*\.sql)$/;
const TEMP_SUFFIX = ".renumber-tmp";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${(result.stderr ?? "").trim() || `exit ${result.status}`}`);
  return result.stdout ?? "";
}

const lines = (text) => text.split(/\r?\n/).filter(Boolean);

/** The folder as git spells it: forward slashes, no trailing slash. */
export const posixDir = (dir) => String(dir ?? "").replace(/\\/g, "/").replace(/\/+$/, "");

function parsed(name) {
  const match = MIGRATION.exec(name);
  return match ? { name, number: Number(match[1]), digits: match[1].length, rest: match[2] } : null;
}

/**
 * The renames that put `added` after the highest number in `existing`, in number order, then name order.
 * @returns `{ from, to }` for each name that changes
 */
export function planRenumber(existing, added) {
  const base = existing.map(parsed).filter(Boolean);
  const mine = added.map(parsed).filter(Boolean).sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));
  const last = base.reduce((max, entry) => Math.max(max, entry.number), 0);
  const width = base[0]?.digits ?? mine[0]?.digits ?? 4;
  return mine.flatMap((entry, index) => {
    const to = `${String(last + index + 1).padStart(width, "0")}_${entry.rest}`;
    return to === entry.name ? [] : [{ from: entry.name, to }];
  });
}

/** The migration names in `dir` at `ref`; a ref with no such folder holds none. */
export function migrationsAt(root, ref, dir) {
  try {
    return lines(git(root, ["ls-tree", "--name-only", `${ref}:${dir}`])).filter((name) => MIGRATION.test(name));
  } catch {
    return [];
  }
}

/** The migration names `branch` added in `dir` since its merge base with `onto`. */
export function addedMigrations(root, onto, branch, dir) {
  const base = git(root, ["merge-base", onto, branch]).trim();
  return lines(git(root, ["diff", "--name-only", "--diff-filter=A", base, branch, "--", dir]))
    .filter((file) => path.posix.dirname(file) === dir)
    .map((file) => path.posix.basename(file))
    .filter((name) => MIGRATION.test(name));
}

/** A stem, matched only where no name character follows it, so `0002_add` leaves `0002_add_index` alone. */
const stemPattern = (stem) => new RegExp(stem.replace(/\W/g, (c) => `\\${c}`) + "(?![A-Za-z0-9_])", "g");

/** Renames through a temporary name, so no rename lands on a file that still exists, then rewrites the references. */
export function applyRenumber(root, dir, plan) {
  for (const { from } of plan) git(root, ["mv", `${dir}/${from}`, `${dir}/${from}${TEMP_SUFFIX}`]);
  for (const { from, to } of plan) git(root, ["mv", `${dir}/${from}${TEMP_SUFFIX}`, `${dir}/${to}`]);
  const touched = new Set();
  for (const { from, to } of plan) {
    const oldStem = from.replace(/\.sql$/, "");
    const newStem = to.replace(/\.sql$/, "");
    const found = spawnSync("git", ["grep", "-l", "-I", "-F", oldStem, "--", "."], { cwd: root, encoding: "utf8", windowsHide: true });
    for (const file of lines(found.stdout ?? "")) {
      const full = path.join(root, file);
      writeFileSync(full, readFileSync(full, "utf8").replace(stemPattern(oldStem), () => newStem));
      touched.add(file);
    }
  }
  if (touched.size > 0) git(root, ["add", "--", ...touched]);
  return [...touched];
}

/** @returns the renames made and the files whose references were rewritten */
export function renumber(root, dir, { onto, branch = "HEAD" }) {
  const folder = posixDir(dir);
  const dirty = git(root, ["status", "--porcelain"]).trim() !== "";
  const merging = spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: root, windowsHide: true }).status === 0;
  if (dirty && !merging) throw new Error("the working tree has uncommitted changes; commit or stash them, or run this during a merge");
  const plan = planRenumber(migrationsAt(root, onto, folder), addedMigrations(root, onto, branch, folder));
  const references = plan.length > 0 ? applyRenumber(root, folder, plan) : [];
  return { plan, references };
}

/** `qc migrations`. @returns the exit code */
export function runMigrations(config, argv, { say = (line) => console.log(line) } = {}) {
  const [sub, ...rest] = argv;
  if (sub !== "renumber") {
    console.error(USAGE);
    return 2;
  }
  let values;
  try {
    ({ values } = parseArgs({ args: rest, options: { onto: { type: "string" }, branch: { type: "string" } }, strict: true }));
    if (!values.onto) throw new Error("--onto <ref> is required");
  } catch (error) {
    console.error(`qc migrations: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  const dir = posixDir(config.paths.migrations);
  try {
    const { plan, references } = renumber(config.root, dir, { onto: values.onto, branch: values.branch ?? "HEAD" });
    for (const { from, to } of plan) say(`rename ${dir}/${from} -> ${to}`);
    for (const file of references) say(`ref    ${file}`);
    say(plan.length === 0 ? `OK  migrations already follow ${values.onto}` : `OK  ${plan.length} migration(s) renumbered after ${values.onto}`);
    return 0;
  } catch (error) {
    console.error(`qc migrations: ${error.message}`);
    return 1;
  }
}
