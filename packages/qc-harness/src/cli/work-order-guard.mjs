#!/usr/bin/env node
// Enforces swarm.md: a work order owns an exclusive set of paths, on one declared branch.
// The PreToolUse path holds the edit-time check (deny) and an advisory branch warning; the
// pre-commit path (runWorkOrderCheck) is the one that actually refuses a commit on the
// wrong branch — a path violation is caught at edit time, a branch violation only exists at
// commit time, since the working directory's checked-out branch can change between edits.
//
// No-op without an opt-in manifest, the same rule every hook in this plugin follows — a
// single agent working alone declares no work order and is never restricted.
//
// This is a single-directory mechanism: concurrent agents that share one working directory
// share one manifest. Agents given their own git worktree (Claude Code's `isolation:
// "worktree"`, or an orchestrator that checks one out by hand) each get their own manifest
// file for free and need nothing further from this script.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { load } from "../config.mjs";
import {
  OFF,
  denyOutput as isolationDeny,
  isolationRefusal,
  isolationSettings,
  worktreeKind,
} from "./worktree-isolation.mjs";

const execFileAsync = promisify(execFile);

export function globToRegExp(glob) {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${body}$`);
}

/** @param {string} relPath forward-slash, relative to the work order manifest's own root */
export function isAllowed(relPath, patterns) {
  return patterns.length === 0 || patterns.some((glob) => globToRegExp(glob).test(relPath));
}

/** @returns a reason string when the branch is wrong, or null when it matches or nothing is declared */
export function branchMismatch(expectedBranch, currentBranch) {
  if (!expectedBranch) return null;
  if (currentBranch === expectedBranch) return null;
  return `On "${currentBranch || "(detached HEAD)"}", but the work order declares "${expectedBranch}".`;
}

/** True during a rebase or cherry-pick, when HEAD is detached on purpose and no branch check applies. */
export function inSpecialGitOperation(gitDir, exists = existsSync) {
  return ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"].some((marker) =>
    exists(path.join(gitDir, marker)),
  );
}

/** The nearest folder at or above a file that exists, since a Write may create the file's folders. */
export function nearestExistingDir(file, exists = existsSync) {
  let dir = path.dirname(file);
  while (!exists(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return dir;
}

export function denyOutput(relPath, patterns) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `"${relPath}" is outside this work order's declared paths ` +
        `(.claude/work-order.local.json: ${patterns.join(", ")}). ` +
        "Ask the orchestrator before editing outside scope, or update the manifest if the scope was wrong.",
    },
  };
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/** Empty string on detached HEAD; trimmed, since a Windows shell can hand back a trailing CRLF. */
async function currentBranch(root) {
  const { stdout } = await execFileAsync("git", ["branch", "--show-current"], { cwd: root });
  return stdout.trim();
}

/** Reads the three git facts the isolation decision needs, in one pass. */
async function gitState(root) {
  const read = async (...args) => (await execFileAsync("git", args, { cwd: root })).stdout.trim();
  const [branch, gitDir, commonDir] = await Promise.all([
    read("branch", "--show-current"),
    read("rev-parse", "--absolute-git-dir"),
    read("rev-parse", "--path-format=absolute", "--git-common-dir"),
  ]);
  return { branch, gitDir, kind: worktreeKind(gitDir, commonDir) };
}

const LEASE_FILE = "qc-agent-lease.json";

function readLease(gitDir) {
  const file = path.join(gitDir, LEASE_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The lease lives in the worktree's own git dir: never committed, and gone when the worktree is. */
function claimLease(gitDir, sessionId, branch) {
  if (!sessionId) return;
  try {
    const payload = { sessionId, branch, updatedAt: new Date().toISOString() };
    writeFileSync(path.join(gitDir, LEASE_FILE), `${JSON.stringify(payload, null, 2)}\n`);
  } catch {
    // A read-only or absent git dir is not a reason to block an edit.
  }
}

/** The checkout that holds a file, and the file's path inside it, or null when no checkout does. */
async function checkoutOf(file) {
  const dir = nearestExistingDir(file);
  if (!dir) return null;
  let top;
  try {
    top = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: dir })).stdout.trim();
  } catch {
    return null;
  }
  // Git and the hook input can spell one folder two ways on Windows: short names, slash direction.
  const root = realpathSync.native(top);
  const inside = path.join(realpathSync.native(dir), path.relative(dir, file));
  return { root, rel: path.relative(root, inside).split(path.sep).join("/") };
}

/** @returns a deny payload when this agent may not generate code here, or null. */
async function isolationVerdict(root, relPath, sessionId) {
  let settings;
  try {
    settings = isolationSettings(load(root).swarm);
  } catch (error) {
    return isolationDeny(error.message);
  }
  if (settings.require === OFF) return null;
  if (isAllowed(relPath, settings.allow) && settings.allow.length > 0) return null;

  let state;
  try {
    state = await gitState(root);
  } catch {
    return null;
  }
  const reason = isolationRefusal({
    settings,
    branch: state.branch,
    kind: state.kind,
    inSpecialOperation: inSpecialGitOperation(state.gitDir),
    lease: readLease(state.gitDir),
    sessionId,
    now: Date.now(),
  });
  if (reason) return isolationDeny(reason);
  claimLease(state.gitDir, sessionId, state.branch);
  return null;
}

export async function run(root) {
  const input = await readStdin();
  let call;
  try {
    call = JSON.parse(input);
  } catch {
    return null;
  }
  return decide(call, root);
}

/** The verdict on one Write or Edit call. @returns a deny payload, or null to allow it. */
export async function decide(call, root) {
  const file = call.tool_input?.file_path;
  if (!file) return null;
  const absolute = path.resolve(root, file);
  const rel = path.relative(root, absolute).split(path.sep).join("/");

  // Isolation binds the checkout that holds the file, whichever one the session opened, and binds
  // the agent that declared no work order too -- the one that edits the trunk by accident.
  const checkout = await checkoutOf(absolute);
  if (checkout) {
    const refusal = await isolationVerdict(checkout.root, checkout.rel, call.session_id);
    if (refusal) return refusal;
  }

  const manifestPath = path.join(root, ".claude", "work-order.local.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  await warnOnBranchMismatch(root, manifest);

  const patterns = manifest.paths ?? [];
  if (isAllowed(rel, patterns)) return null;
  return denyOutput(rel, patterns);
}

/** Advisory only — never blocks the edit. The pre-commit hook is the one that refuses the commit. */
async function warnOnBranchMismatch(root, manifest) {
  if (!manifest.branch) return;
  try {
    const reason = branchMismatch(manifest.branch, await currentBranch(root));
    if (reason) console.error(`work-order-guard: ${reason}`);
  } catch {
    // Not a git checkout, or git is unavailable — the pre-commit hook is still authoritative.
  }
}

/** The pre-commit git hook's own check — refuses the commit itself, not just an edit. */
export async function runWorkOrderCheck(root) {
  // Isolation is checked here as well as at edit time, and this is the check that binds: the
  // PreToolUse hook only sees the Write and Edit tools, so an agent writing through a shell
  // -- sed, a heredoc, a script -- never reaches it. A commit cannot be made without git.
  if (await isolationCommitRefusal(root)) return 1;

  const manifestPath = path.join(root, ".claude", "work-order.local.json");
  if (!existsSync(manifestPath)) return 0;

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest.branch) return 0;
  if (inSpecialGitOperation(path.join(root, ".git"))) return 0;

  const reason = branchMismatch(manifest.branch, await currentBranch(root));
  if (!reason) return 0;
  console.error(`${reason} Switch branches before committing, or update the manifest if the work order moved.`);
  return 1;
}

/** The commit-time half of the isolation rule. @returns true when the commit must be refused. */
async function isolationCommitRefusal(root) {
  let settings;
  try {
    settings = isolationSettings(load(root).swarm);
  } catch (error) {
    console.error(error.message);
    return true;
  }
  if (settings.require === OFF) return false;

  let state;
  try {
    state = await gitState(root);
  } catch {
    return false;
  }
  // The lease says which session holds the worktree, and a commit is not an edit: whoever
  // holds it may commit, so only the branch and worktree halves apply here.
  const reason = isolationRefusal({
    settings,
    branch: state.branch,
    kind: state.kind,
    inSpecialOperation: inSpecialGitOperation(state.gitDir),
    lease: null,
    sessionId: null,
    now: Date.now(),
  });
  if (!reason) return false;
  console.error(`swarm isolation: ${reason}`);
  return true;
}

// A hand-built `file://${argv[1]}` never matches on Windows; compare native paths instead.
const isEntryPoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntryPoint) {
  const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const output = await run(root);
  if (output) process.stdout.write(JSON.stringify(output));
}
