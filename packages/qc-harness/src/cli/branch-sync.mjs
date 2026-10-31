import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { globMatcher } from "../glob.mjs";
import { runGateSlot } from "./gate-slot.mjs";
import { git, lines, runShell, tryGit } from "./integrate.mjs";
import { posixDir, renumber } from "./migrations.mjs";
import { pauseRefusal } from "./pause.mjs";

export const USAGE = "qc branch sync <worktree> [--base <ref>] [--no-push]\nexit 5 paused or cannot read the operator pause";

/** A fragment: hold a machine slot while an action runs in its worktree. */
const inGateSlot = (words, _cwd, action) => runGateSlot(["--", ...words], { run: action });

/** A branch: refuse changes when the operator pause exists or cannot be read. */
function assertRunning(worktree) {
  let refusal;
  try {
    refusal = pauseRefusal(worktree);
  } catch (error) {
    refusal = `cannot read the operator pause (${error.message}). Wait for the operator to run \`qc resume\`.`;
  }
  if (refusal) throw Object.assign(new Error(refusal), { exitCode: 5 });
}

/** A branch: dispatch a sync and push its changes through a machine gate slot. */
export async function runBranch(config, argv, deps = {}) {
  const {
    say = (line) => console.log(line),
    run,
    withSlot = inGateSlot,
    runSlot = (words, cwd) => withSlot(words, cwd, () =>
      spawnSync(words[0], words.slice(1), { cwd, stdio: "inherit", windowsHide: true }).status ?? 1),
  } = deps;
  let values;
  let positionals;
  try {
    if (argv[0] !== "sync") throw new Error("expected the sync sub-command");
    ({ values, positionals } = parseArgs({
      args: argv.slice(1),
      options: { base: { type: "string" }, "no-push": { type: "boolean" } },
      strict: true,
      allowPositionals: true,
    }));
    if (positionals.length !== 1) throw new Error("name exactly one worktree");
  } catch (error) {
    say(`qc branch: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  try {
    const worktree = path.resolve(config.root, positionals[0]);
    const result = await syncBranch(config, worktree, { base: values.base, say, run, withSlot });
    if (result.code !== 0 || !result.changed || values["no-push"]) return result.code;
    assertRunning(config.root);
    say(`push  ${result.branch}`);
    return await runSlot(["git", "push", "-u", "origin", result.branch], worktree);
  } catch (error) {
    say(`qc branch: ${error.message}`);
    return error.exitCode === 5 ? 5 : 1;
  }
}

/** A pipeline: merge the base, renumber the branch's migrations, and commit generated files. */
export async function syncBranch(config, worktree, options = {}) {
  assertRunning(config.root);
  const { say = (line) => console.log(line), run = runShell, withSlot = inGateSlot } = options;
  const base = options.base ?? config.worktree?.base ?? "origin/main";
  if (tryGit(worktree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok) throw new Error("a merge is in progress: resolve it and commit it first");
  const branch = git(worktree, ["branch", "--show-current"]).trim();
  if (!branch) throw new Error("HEAD is detached: switch to a branch first");
  if ((config.swarm?.isolation?.protectedBranches ?? []).includes(branch)) throw new Error(`cannot sync protected branch ${branch}`);
  if (git(worktree, ["status", "--porcelain"]).trim() !== "") throw new Error("the working tree has changes: commit or stash them first");
  const [targetCommon, rootCommon] = [worktree, config.root].map((directory) => {
    const common = realpathSync.native(git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
    return process.platform === "win32" ? common.toLowerCase() : common;
  });
  if (targetCommon !== rootCommon) throw new Error("the target belongs to another repository: choose a worktree of the repository root");
  tryGit(worktree, ["fetch", "--quiet", "origin"]);
  if (!tryGit(worktree, ["rev-parse", "-q", "--verify", `${base}^{commit}`]).ok) throw new Error(`unknown base ${base}`);
  const alreadyMerged = tryGit(worktree, ["merge-base", "--is-ancestor", base, "HEAD"]).ok;
  if (alreadyMerged) {
    say(`OK  ${branch} already holds ${base}`);
    const upstream = tryGit(worktree, ["rev-parse", "--verify", "@{upstream}"]);
    if (upstream.ok && git(worktree, ["rev-list", "--count", `${upstream.out.trim()}..HEAD`]).trim() === "0") {
      return { code: 0, changed: false };
    }
  }

  if (!alreadyMerged) {
    const merged = tryGit(worktree, ["merge", "--no-ff", "--no-commit", base]);
    if (!merged.ok) {
      const conflicts = lines(git(worktree, ["diff", "--name-only", "--diff-filter=U"]));
      if (conflicts.length === 0) throw new Error(`git merge ${base}: ${merged.err}`);
      const generated = globMatcher(config.generated?.globs ?? []);
      const byHand = conflicts.filter((file) => !generated(file) || !config.generated?.command);
      if (byHand.length > 0) {
        say(`CONFLICT merging ${base}; the merge is left in progress. Files:`);
        for (const file of byHand) say(`  ${file}`);
        if (!config.generated?.command && conflicts.some(generated)) say("Set generated.command or resolve the generated files by hand.");
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
    const commit = ["commit", "-q", "--no-edit"];
    await withSlot(["git", ...commit], worktree, () => git(worktree, commit));
  }

  const command = config.generated?.command;
  if (command) {
    if (await withSlot([command], worktree, () => run(command, worktree)) !== 0) throw new Error(`generated.command failed: ${command} failed`);
    if (git(worktree, ["status", "--porcelain"]).trim() !== "") {
      git(worktree, ["add", "-A"]);
      const issue = /^[a-z]+\/(\d+)-/.exec(branch)?.[1];
      const commit = ["commit", "-q", "-m", "chore: regenerate the generated files", ...(issue ? ["-m", `Refs #${issue}`] : [])];
      await withSlot(["git", ...commit], worktree, () => git(worktree, commit));
    }
  }
  return { code: 0, changed: true, branch };
}
