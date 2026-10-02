// A pipeline: `qc worktree add` makes a linked worktree under `worktree.dir` in the main checkout, and installs it.
// `qc worktree remove` deletes one, and deletes its branch only when no commit would be lost. QC-015.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { runGh } from "./gh-run.mjs";

export const USAGE = `qc worktree — a linked worktree under .worktree/ in the main checkout

  qc worktree add <name> <branch> [--from <ref>]   fetch, add .worktree/<name> on <branch>, install, print the path
  qc worktree remove <name> [--from <ref>]         refuse a dirty tree; delete it, then the branch once merged, pushed, or a merged PR head

  --from  the ref a new branch starts at, and the ref remove checks a merge against.
          The default is worktree.base in qc.config.json. The install is worktree.install.
          The folder is worktree.dir. remove also finds a worktree at ../<name>, beside the main checkout.`;

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
}

/** One spelling per folder: Windows hands out short 8.3 names, and git prints the long ones. */
export function keyOf(file) {
  let real;
  try {
    real = realpathSync.native(file);
  } catch {
    const parent = path.dirname(file);
    real = parent === file ? file : path.join(keyOf(parent), path.basename(file));
  }
  return process.platform === "win32" ? path.resolve(real).toLowerCase() : path.resolve(real);
}

function commonDir(cwd) {
  const common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return common.ok ? common.out : null;
}

/** Adds `<dir>/` to info/exclude when no rule ignores the target, so the main checkout's status stays clean. */
function ignoreFolder(common, main, dir, target) {
  if (git(main, "check-ignore", "-q", path.relative(main, target).split(path.sep).join("/")).ok) return;
  const exclude = path.join(common, "info", "exclude");
  mkdirSync(path.dirname(exclude), { recursive: true });
  const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  appendFileSync(exclude, `${text === "" || text.endsWith("\n") ? "" : "\n"}${dir.replace(/\/+$/, "")}/\n`);
}

/** @returns {{path: string, branch?: string}[]} */
function worktrees(main) {
  return git(main, "worktree", "list", "--porcelain")
    .out.split(/\n\s*\n/)
    .map((block) => {
      const field = (name) => block.split("\n").find((line) => line.startsWith(`${name} `))?.slice(name.length + 1);
      return { path: field("worktree"), branch: field("branch")?.replace(/^refs\/heads\//, "") };
    })
    .filter((entry) => entry.path);
}

async function add(config, main, target, branch, from) {
  const found = worktrees(main).find((entry) => keyOf(entry.path) === keyOf(target));
  if (found && found.branch !== branch) {
    console.error(`${target} is a worktree on ${found.branch ?? "a detached HEAD"}, not ${branch}.`);
    return 1;
  }
  if (!found) {
    if (existsSync(target)) {
      console.error(`${target} exists and is not a worktree of this repository.`);
      return 1;
    }
    ignoreFolder(commonDir(main), main, config.worktree.dir, target);
    const fetched = git(main, "fetch", "--quiet");
    if (!fetched.ok) {
      console.error(fetched.err);
      return 1;
    }
    const exists = git(main, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`).ok;
    const made = exists
      ? git(main, "worktree", "add", target, branch)
      : git(main, "worktree", "add", target, "-b", branch, from);
    if (!made.ok) {
      console.error(made.err);
      return 1;
    }
  }
  // Every add runs the install, so a second add finishes what a failed install left.
  const install = config.worktree?.install;
  if (install) {
    const ran = spawnSync(install, { cwd: target, shell: true, stdio: "inherit" });
    if (ran.status !== 0) {
      console.error(`the install failed in ${target}: ${install}`);
      return ran.status ?? 1;
    }
  }
  console.log(target);
  return 0;
}

/** The merged PR whose head is `branch` at `tip`, so a squash merge counts. A gh that fails or is absent proves nothing. */
function mergedPr(main, branch, tip, gh) {
  const out = gh(["pr", "list", "--head", branch, "--state", "merged", "--json", "number,headRefOid"], { cwd: main });
  try {
    const prs = out === null ? [] : JSON.parse(out);
    return (Array.isArray(prs) && prs.find((pr) => tip !== "" && pr?.headRefOid === tip)) || null;
  } catch {
    return null;
  }
}

/**
 * A branch goes when the base holds it, its upstream holds every commit, or a merged PR has it as its head at its tip.
 * The remote branch goes too while it is still at the head of that merged PR.
 */
function settleBranch(main, branch, from, gh) {
  const tip = git(main, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).out;
  const merged = git(main, "merge-base", "--is-ancestor", branch, from).ok;
  const upstream = git(main, "rev-parse", "--abbrev-ref", `${branch}@{upstream}`);
  const pushed = upstream.ok && git(main, "rev-list", "--count", `${upstream.out}..${branch}`).out === "0";
  const remote = git(main, "ls-remote", "--heads", "origin", `refs/heads/${branch}`);
  const onRemote = remote.ok && tip !== "" && remote.out.split(/\s/)[0] === tip;
  const pr = (!merged && !pushed) || onRemote ? mergedPr(main, branch, tip, gh) : null;
  if (!merged && !pushed && !pr) return `kept branch ${branch}: ${from} does not hold it, and it has commits no remote holds`;
  const deleted = git(main, "branch", "-D", branch);
  const lines = [deleted.ok ? `deleted branch ${branch}` : `kept branch ${branch}: ${deleted.err}`];
  if (pr && onRemote) {
    const gone = git(main, "push", "--quiet", "origin", "--delete", branch);
    lines.push(gone.ok ? `deleted origin/${branch}, the head of merged #${pr.number}` : `kept origin/${branch}: ${gone.err}`);
  }
  return lines.join("\n");
}

async function remove(main, targets, from, gh) {
  const listed = worktrees(main);
  const found = targets.map((target) => listed.find((entry) => keyOf(entry.path) === keyOf(target))).find(Boolean);
  const target = found?.path ?? targets[0];
  if (keyOf(target) === keyOf(main)) {
    console.error("refusing to remove the main checkout.");
    return 1;
  }
  if (!found) {
    if (existsSync(target)) {
      console.error(`${target} is not a worktree of this repository. Nothing was removed.`);
      return 1;
    }
    console.log(`no worktree at ${target}; nothing to remove`);
    return 0;
  }
  if (existsSync(target)) {
    const status = git(target, "status", "--porcelain");
    if (!status.ok || status.out !== "") {
      console.error(`${target} has uncommitted changes. Commit or discard them first:\n${status.out || status.err}`);
      return 1;
    }
    // `git worktree remove` fails on Windows past 260 characters. Node's fs reaches long paths.
    await rm(target, { recursive: true, force: true, maxRetries: 5 });
  }
  git(main, "worktree", "prune");
  if (found.branch) console.log(settleBranch(main, found.branch, from, gh));
  console.log(`removed ${target}`);
  return 0;
}

/**
 * @param {object} config
 * @param {string[]} args `add <name> <branch> [--from <ref>]` or `remove <name> [--from <ref>]`
 * @param {{gh?: typeof runGh}} [io] the gh call that proves a squash merge
 * @returns {Promise<number>} the exit code
 */
export async function runWorktree(config, args, { gh = runGh } = {}) {
  const [command, ...rest] = args;
  const at = rest.indexOf("--from");
  const from = at === -1 ? config.worktree?.base ?? "origin/main" : rest[at + 1];
  const [name, branch] = at === -1 ? rest : [...rest.slice(0, at), ...rest.slice(at + 2)];
  const common = commonDir(config.root);
  const main = common && path.dirname(common);
  const usable = main && from && name && !/[\\/]/.test(name) && name !== "." && name !== "..";
  if (!usable || !(command === "remove" || (command === "add" && branch))) {
    console.error(main ? USAGE : "qc worktree runs inside a git repository.");
    return 1;
  }
  const inside = path.join(main, config.worktree.dir, name);
  return command === "add" ? add(config, main, inside, branch, from) : remove(main, [inside, path.join(path.dirname(main), name)], from, gh);
}
