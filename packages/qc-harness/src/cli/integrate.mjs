// `qc integrate`: one integration branch for a batch of branches, with pushes at the configured CI cadence.
// Each merge renumbers its migrations, and a conflict in generated files is settled by the generator.

import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { globMatcher } from "../glob.mjs";
import { runGh } from "./gh-run.mjs";
import { posixDir, renumber } from "./migrations.mjs";

export const USAGE = `qc integrate — one integration branch for a batch of branches

  qc integrate --issue <n> [--type <type>] [--slug <slug>] [--from <ref>] [--pr] <branch>...
      make <type>/<n>-<slug> from <ref> (worktree.base by default), or continue it when it exists;
      merge each branch in order, renumber its migrations after the last one before it, and commit;
      run generated.command, commit its output, and push to origin every integrate.ciEvery merges
      (3 by default), then settle and push any remaining changes. Set integrate.push to false for
      manual pushes. An absent origin skips pushes. A conflict stops the run and lists the files.
      Resolve it, commit, and run the same command again: a branch already merged is skipped.
      --pr opens a draft pull request after the first push; it requires pushes and an origin remote.
      It refuses each branch with an author email other than the effective Git author email.`;

export function tryGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { ok: result.status === 0, out: result.stdout ?? "", err: (result.stderr ?? "").trim() };
}

export function git(cwd, args) {
  const result = tryGit(cwd, args);
  if (!result.ok) throw new Error(`git ${args.join(" ")}: ${result.err || "failed"}`);
  return result.out;
}

export const lines = (text) => text.split(/\r?\n/).filter(Boolean);

export function runShell(command, cwd) {
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
    options: { issue: { type: "string" }, type: { type: "string" }, slug: { type: "string" }, from: { type: "string" }, pr: { type: "boolean" } },
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

/** Branch: derive the pull request base from a local or remote branch ref. */
function pullRequestBase(root, ref) {
  if (typeof ref === "string") {
    const local = ref.replace(/^refs\/heads\//, "");
    if (tryGit(root, ["show-ref", "--verify", "--quiet", `refs/heads/${local}`]).ok) return local;
    const remoteRef = ref.replace(/^refs\/remotes\//, "");
    const remote = lines(git(root, ["remote"])).find((name) => remoteRef.startsWith(`${name}/`));
    if (remote && tryGit(root, ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteRef}`]).ok) {
      const branch = remoteRef.slice(remote.length + 1);
      if (tryGit(root, ["check-ref-format", "--branch", branch]).ok) return branch;
    }
  }
  throw new Error(`the pull request base must name a branch, got ${JSON.stringify(ref)}`);
}

/** Branch: read a Git identity and require its email. */
function identityEmail(root, role) {
  const variable = `GIT_${role.toUpperCase()}_IDENT`;
  const identity = git(root, ["var", variable]).trim();
  const email = /<([^<>]+)> \d+ [+-]\d{4}$/.exec(identity)?.[1];
  if (!email) throw new Error(`git var ${variable} returned no ${role} email`);
  return email;
}

/** `qc integrate`. @returns the exit code */
export async function runIntegrate(config, argv, { say = (line) => console.log(line), run = runShell, gh = runGh } = {}) {
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
    const canPush = config.integrate?.push !== false && tryGit(root, ["remote", "get-url", "origin"]).ok;
    if (options.pr && !canPush) throw new Error("a pull request needs a pushed branch: enable integrate.push and configure origin");
    if (tryGit(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok) throw new Error("a merge is in progress: resolve it, commit it, then run qc integrate again");
    if (git(root, ["status", "--porcelain"]).trim() !== "") throw new Error("the working tree has changes: commit or stash them first");
    const email = identityEmail(root, "author");
    identityEmail(root, "committer");
    tryGit(root, ["fetch", "--quiet", "origin"]);
    const base = options.from ?? config.worktree?.base ?? "origin/main";
    const prBase = options.pr
      ? pullRequestBase(root, options.from && /^[0-9a-f]{7,64}$/i.test(options.from) ? config.integrate?.base ?? "main" : base)
      : null;
    if (git(root, ["branch", "--show-current"]).trim() !== name) {
      if (tryGit(root, ["rev-parse", "-q", "--verify", `refs/heads/${name}`]).ok) git(root, ["switch", "-q", name]);
      else git(root, ["switch", "-q", "-c", name, base]);
    }
    const dir = posixDir(config.paths?.migrations);
    const generated = globMatcher(config.generated?.globs ?? []);
    const ciEvery = config.integrate?.ciEvery ?? 3;
    let merges = 0;
    let pushed = false;
    let opened = false;

    /** Pipeline: ensure the published integration branch has a pull request. */
    function ensurePullRequest() {
      if (!options.pr || opened) return;
      if (gh(["pr", "view", name, "--json", "number"], { cwd: root }) !== null) {
        say("pr     exists");
      } else {
        const result = gh([
          "pr", "create", "--draft", "--head", name, "--base", prBase,
          "--title", `${options.type ?? "feat"}: integrate the batch for #${options.issue}`, "--body", `Refs #${options.issue}`,
        ], { cwd: root });
        if (result === null) throw new Error("gh pr create failed");
        say(`pr     ${result.trim()}`);
      }
      opened = true;
    }

    /** Pipeline: regenerate and commit the integration branch before a push. */
    function settle() {
      const command = config.generated?.command;
      if (command) {
        if (run(command, root) !== 0) throw new Error(`${command} failed; fix it, commit, and run qc integrate again`);
        if (git(root, ["status", "--porcelain"]).trim() !== "") {
          git(root, ["add", "-A"]);
          git(root, ["commit", "-q", "-m", "chore: regenerate the generated files", "-m", `Refs #${options.issue}`]);
          say(`commit the output of ${command}`);
        }
      }
    }

    /** Branch: publish the integration branch when its remote tracking ref differs. */
    function pushIfAhead() {
      if (!canPush) return;
      const remote = tryGit(root, ["rev-parse", "--verify", `refs/remotes/origin/${name}`]);
      if (git(root, ["rev-parse", "HEAD"]).trim() === remote.out.trim()) return;
      git(root, ["push", "-u", "origin", name]);
      say(`push   ${name}`);
      pushed = true;
      ensurePullRequest();
    }

    for (const branch of options.branches) {
      const others = [...new Set(lines(git(root, ["log", "--format=%ae", `${base}..${branch}`, "--"])))].filter((author) => author !== email);
      if (others.length > 0) throw new Error(`refuse branch ${branch}: authors differ from effective Git author email ${email}: ${others.join(", ")}`);
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
      merges += 1;
      if (merges === ciEvery) {
        settle();
        pushIfAhead();
        merges = 0;
      }
    }
    settle();
    pushIfAhead();
    if (options.pr && tryGit(root, ["rev-parse", "--verify", `refs/remotes/origin/${name}`]).ok) ensurePullRequest();
    const hint = pushed ? "" : ` Push it: git push -u origin ${name}`;
    say(`OK  ${name} holds ${options.branches.length} branch(es).${hint}`);
    return 0;
  } catch (error) {
    console.error(`qc integrate: ${error.message}`);
    return 1;
  }
}
