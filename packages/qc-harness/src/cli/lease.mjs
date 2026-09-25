// `qc lease`, the trigger that shows and releases the worktree lease the edit guard claims.
// A lease another session holds is released only on purpose: by its holder, or by a person with --force.

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { load } from "../config.mjs";
import { leaseFileOf, readLease, removeLease } from "./lease-file.mjs";
import { OFF, duration, isolationSettings, leaseState, sessionIdOf, timestamp } from "./worktree-isolation.mjs";

const execFileAsync = promisify(execFile);

export const USAGE = `qc lease — the lease that holds a worktree for one agent session

  qc lease status [path]                  its holder, branch, age, and the time it lapses
  qc lease release [path] --session <id>  remove the lease that this session holds
  qc lease release [path] --force         remove any lease, and print what it removed

path is any folder inside the worktree, and defaults to the current directory.`;

/** The worktree root and git dir that hold a path, or null when no checkout does. */
async function worktreeAt(target) {
  const absolute = path.resolve(target);
  const dir = existsSync(absolute) && !statSync(absolute).isDirectory() ? path.dirname(absolute) : absolute;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir"], { cwd: dir });
    const [root, gitDir] = stdout.trim().split(/\r?\n/);
    return { root, gitDir };
  } catch {
    return null;
  }
}

const NO_TIME = "(no readable time)";

const written = (state) =>
  Number.isNaN(state.written) ? NO_TIME : `${timestamp(state.written)}, ${duration(Math.max(state.age, 0))} ago`;

function lapses(state, now) {
  if (Number.isNaN(state.lapsesAt)) return NO_TIME;
  const when = now > state.lapsesAt ? `${duration(now - state.lapsesAt)} ago` : `in ${duration(state.lapsesAt - now)}`;
  return `${timestamp(state.lapsesAt)}, ${when}`;
}

function verdict(state, settings) {
  if (settings.require === OFF) return "inactive: swarm.isolation.require is off, so no edit reads it";
  if (state.holder === null || Number.isNaN(state.written)) return "unreadable: it binds no session";
  if (state.live) return "held: an edit from any other session is refused";
  return state.age < 0 ? "written in the future: it binds no session" : "lapsed: it binds no session";
}

/** The status report as lines. `lease` is undefined when there is no file, and null when it does not parse. */
export function statusLines(file, lease, settings, now) {
  if (lease === undefined) return [`no lease: ${file} does not exist`];
  const state = leaseState(lease, now, settings.leaseHours);
  return [
    `lease    ${file}`,
    `holder   ${state.holder ?? "(none)"}`,
    `branch   ${state.branch ?? "(none)"}`,
    `written  ${written(state)}`,
    `lapses   ${lapses(state, now)}`,
    `state    ${verdict(state, settings)}`,
  ];
}

/** @returns null when the release may go ahead, or the reason it may not. */
export function releaseRefusal(lease, { session, force }) {
  if (force) return null;
  const caller = sessionIdOf(session);
  const holder = sessionIdOf(lease?.sessionId);
  if (!caller) {
    return `refused: pass --session <id> to release your own lease, or --force to release any lease. Holder: ${holder ?? "(none)"}.`;
  }
  if (holder === null) return "refused: the lease names no readable holder, so only --force removes it.";
  if (caller === holder) return null;
  return `refused: session ${holder} holds this lease, not ${caller}. Only its holder releases it without --force.`;
}

function removed(file, lease, now) {
  // A release reads no config, so a broken one cannot block it; the lapse is not needed here.
  const state = leaseState(lease, now, Number.POSITIVE_INFINITY);
  return `released ${file}: session ${state.holder ?? "(none)"} on "${state.branch ?? "(none)"}", written ${written(state)}`;
}

export async function runLease(args, now = Date.now()) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: { session: { type: "string" }, force: { type: "boolean", default: false } },
    });
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 1;
  }
  const [action, target = process.cwd(), ...extra] = parsed.positionals;
  if (!["status", "release"].includes(action) || extra.length > 0) {
    console.log(USAGE);
    return action === undefined || action === "help" ? 0 : 1;
  }

  const worktree = await worktreeAt(target);
  if (!worktree) {
    console.error(`${target} is not inside a git checkout, so it has no lease.`);
    return 1;
  }
  const file = leaseFileOf(worktree.gitDir);
  const lease = existsSync(file) ? readLease(worktree.gitDir) : undefined;

  if (action === "status") {
    let settings;
    try {
      settings = isolationSettings(load(worktree.root).swarm);
    } catch (error) {
      console.error(error.message);
      return 1;
    }
    for (const line of statusLines(file, lease, settings, now)) console.log(line);
    return 0;
  }

  if (lease === undefined) {
    console.log(`no lease: ${file} does not exist`);
    return 0;
  }
  const refusal = releaseRefusal(lease, parsed.values);
  if (refusal) {
    console.error(refusal);
    return 1;
  }
  removeLease(worktree.gitDir);
  console.log(removed(file, lease, now));
  return 0;
}
