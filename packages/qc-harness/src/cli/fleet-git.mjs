import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
// A fast call (fetch, rev-parse, ls-remote) answers in seconds; a hung network still stops in a minute.
export const SHORT_GIT_MS = 60_000;
// A repo hook can install packages for each new checkout; three such installs at once passed 60 s on 11/28.
export const LONG_GIT_MS = 20 * 60_000;
export const GIT_BUFFER_BYTES = 64 * 1024 * 1024;
// These commands can run a repo hook: post-checkout, pre-commit, pre-push or post-merge.
const HOOK_COMMANDS = new Set(["am", "checkout", "cherry-pick", "commit", "merge", "pull", "push", "rebase", "revert", "switch"]);

/** Skip global options such as `-c key=value` to find the git subcommand. */
function subcommand(args) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (["-c", "-C", "--git-dir", "--work-tree", "--namespace"].includes(arg)) { index++; continue; }
    if (!arg.startsWith("-")) return [arg, args[index + 1]];
  }
  return [];
}

export function gitLimits(args) {
  const [command, sub] = subcommand(args);
  const hooks = HOOK_COMMANDS.has(command) || (command === "worktree" && sub === "add");
  return { timeout: hooks ? LONG_GIT_MS : SHORT_GIT_MS, maxBuffer: GIT_BUFFER_BYTES };
}

export const runGit = (root, ...args) => execute("git", args, { cwd: root, ...gitLimits(args), windowsHide: true });
