import { globMatcher } from "../glob.mjs";
import { git, lines, runShell, tryGit } from "./integrate.mjs";
import { posixDir, renumber } from "./migrations.mjs";

/** A pipeline: merge the base, renumber the branch's migrations, and commit generated files. */
export async function syncBranch(config, worktree, options = {}) {
  const { say = (line) => console.log(line), run = runShell } = options;
  const base = options.base ?? config.worktree?.base ?? "origin/main";
  if (tryGit(worktree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok) throw new Error("a merge is in progress: resolve it and commit it first");
  const branch = git(worktree, ["branch", "--show-current"]).trim();
  if (!branch) throw new Error("HEAD is detached: switch to a branch first");
  if ((config.swarm?.isolation?.protectedBranches ?? []).includes(branch)) throw new Error(`cannot sync protected branch ${branch}`);
  if (git(worktree, ["status", "--porcelain"]).trim() !== "") throw new Error("the working tree has changes: commit or stash them first");
  tryGit(worktree, ["fetch", "--quiet", "origin"]);
  if (!tryGit(worktree, ["rev-parse", "-q", "--verify", `${base}^{commit}`]).ok) throw new Error(`unknown base ${base}`);
  if (tryGit(worktree, ["merge-base", "--is-ancestor", base, "HEAD"]).ok) {
    say(`OK  ${branch} already holds ${base}`);
    return { code: 0, changed: false };
  }

  const merged = tryGit(worktree, ["merge", "--no-ff", "--no-commit", base]);
  if (!merged.ok) {
    const conflicts = lines(git(worktree, ["diff", "--name-only", "--diff-filter=U"]));
    if (conflicts.length === 0) throw new Error(`git merge ${base}: ${merged.err}`);
    const generated = globMatcher(config.generated?.globs ?? []);
    const byHand = conflicts.filter((file) => !generated(file));
    if (byHand.length > 0) {
      say(`CONFLICT merging ${base}; the merge is left in progress. Files:`);
      for (const file of byHand) say(`  ${file}`);
      say(`Resolve them, run \`qc migrations renumber --onto ${base}\`, commit, and run qc branch sync again.`);
      return { code: 1 };
    }
    git(worktree, ["checkout", "--ours", "--", ...conflicts]);
    git(worktree, ["add", "--", ...conflicts]);
  }
  const dir = posixDir(config.paths?.migrations);
  if (dir) {
    for (const { from, to } of renumber(worktree, dir, { onto: base, branch: "HEAD" }).plan) say(`rename ${dir}/${from} -> ${to}`);
  }
  git(worktree, ["commit", "-q", "--no-edit"]);

  const command = config.generated?.command;
  if (command) {
    if (await run(command, worktree) !== 0) throw new Error(`generated.command failed: ${command} failed`);
    if (git(worktree, ["status", "--porcelain"]).trim() !== "") {
      git(worktree, ["add", "-A"]);
      const issue = /^[a-z]+\/(\d+)-/.exec(branch)?.[1];
      git(worktree, ["commit", "-q", "-m", "chore: regenerate the generated files", ...(issue ? ["-m", `Refs #${issue}`] : [])]);
    }
  }
  return { code: 0, changed: true, branch };
}
