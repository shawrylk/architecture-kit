// `qc integrate`: one integration branch for a batch of branches, so the batch runs one CI and merges once.
// Each merge renumbers its migrations, and a conflict in generated files is settled by the generator.

import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { globMatcher } from "../glob.mjs";
import { posixDir, renumber } from "./migrations.mjs";

export const USAGE = `qc integrate — one integration branch for a batch of branches

  qc integrate --issue <n> [--type <type>] [--slug <slug>] [--from <ref>] <branch>...
      make <type>/<n>-<slug> from <ref> (worktree.base by default), or continue it when it exists;
      merge each branch in order, renumber its migrations after the last one before it, and commit;
      then run generated.command and commit what it changes. A conflict stops the run and lists the
      files. Resolve it, commit, and run the same command again: a branch already merged is skipped.`;

function tryGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { ok: result.status === 0, out: result.stdout ?? "", err: (result.stderr ?? "").trim() };
}

function git(cwd, args) {
  const result = tryGit(cwd, args);
  if (!result.ok) throw new Error(`git ${args.join(" ")}: ${result.err || "failed"}`);
  return result.out;
}

const lines = (text) => text.split(/\r?\n/).filter(Boolean);

function runShell(command, cwd) {
  return spawnSync(command, { cwd, shell: true, stdio: "inherit", windowsHide: true }).status ?? 1;
}

/** The branch name `<type>/<issue>-<slug>`; throws on an issue that is no number or a type that is no word. */
export function integrationBranch({ issue, type = "feat", slug = "integration" }) {
  if (!/^[1-9]\d*$/.test(String(issue ?? ""))) throw new Error(`--issue must be an issue number, got ${issue}`);
  if (!/^[a-z]+$/.test(type)) throw new Error(`--type must be lowercase letters, got ${type}`);
  const tail = String(slug).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${type}/${issue}-${tail || "integration"}`;
}

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { issue: { type: "string" }, type: { type: "string" }, slug: { type: "string" }, from: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  if (!values.issue) throw new Error("--issue <n> is required");
  if (positionals.length === 0) throw new Error("name at least one branch to merge");
  return { ...values, branches: positionals };
}

const conflictReport = (branch, files) =>
  [
    `CONFLICT merging ${branch}; the merge is left in progress. Files:`,
    ...files.map((file) => `  ${file}`),
    "Resolve them, run `qc migrations renumber --onto HEAD --branch MERGE_HEAD`, commit, and run qc integrate again.",
  ].join("\n");

/** `qc integrate`. @returns the exit code */
export async function runIntegrate(config, argv, { say = (line) => console.log(line), run = runShell } = {}) {
  let options;
  try {
    options = parse(argv);
  } catch (error) {
    console.error(`qc integrate: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  const root = config.root;
  try {
    const name = integrationBranch(options);
    const pattern = config.branches?.pattern;
    if (pattern && !new RegExp(pattern).test(name)) throw new Error(`${name} does not match branches.pattern ${pattern}`);
    if (tryGit(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok) throw new Error("a merge is in progress: resolve it, commit it, then run qc integrate again");
    if (git(root, ["status", "--porcelain"]).trim() !== "") throw new Error("the working tree has changes: commit or stash them first");
    tryGit(root, ["fetch", "--quiet", "origin"]);
    if (git(root, ["branch", "--show-current"]).trim() !== name) {
      if (tryGit(root, ["rev-parse", "-q", "--verify", `refs/heads/${name}`]).ok) git(root, ["switch", "-q", name]);
      else git(root, ["switch", "-q", "-c", name, options.from ?? config.worktree?.base ?? "origin/main"]);
    }
    const dir = posixDir(config.paths?.migrations);
    const generated = globMatcher(config.generated?.globs ?? []);
    for (const branch of options.branches) {
      if (tryGit(root, ["merge-base", "--is-ancestor", branch, "HEAD"]).ok) {
        say(`skip   ${branch}: already merged`);
        continue;
      }
      const merged = tryGit(root, ["merge", "--no-ff", "--no-commit", branch]);
      if (!merged.ok) {
        const conflicts = lines(git(root, ["diff", "--name-only", "--diff-filter=U"]));
        if (conflicts.length === 0) throw new Error(`git merge ${branch}: ${merged.err}`);
        const byHand = conflicts.filter((file) => !generated(file));
        if (byHand.length > 0) {
          say(conflictReport(branch, byHand));
          return 1;
        }
        git(root, ["checkout", "--ours", "--", ...conflicts]);
        git(root, ["add", "--", ...conflicts]);
      }
      if (dir) {
        for (const { from, to } of renumber(root, dir, { onto: "HEAD", branch: "MERGE_HEAD" }).plan) say(`rename ${dir}/${from} -> ${to}`);
      }
      git(root, ["commit", "-q", "--no-edit"]);
      say(`merge  ${branch}`);
    }
    const command = config.generated?.command;
    if (command) {
      if (run(command, root) !== 0) throw new Error(`${command} failed; fix it, commit, and run qc integrate again`);
      if (git(root, ["status", "--porcelain"]).trim() !== "") {
        git(root, ["add", "-A"]);
        git(root, ["commit", "-q", "-m", "chore: regenerate the generated files", "-m", `Refs #${options.issue}`]);
        say(`commit the output of ${command}`);
      }
    }
    say(`OK  ${name} holds ${options.branches.length} branch(es). Push it: git push -u origin ${name}`);
    return 0;
  } catch (error) {
    console.error(`qc integrate: ${error.message}`);
    return 1;
  }
}
