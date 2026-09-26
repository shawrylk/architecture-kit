#!/usr/bin/env node
// The PostToolUse trigger that holds a Bash command to the rules the edit guard holds Write and Edit
// to: the work order's declared paths, and no change on a protected branch. A shell write through
// sed, a script or a codemod never reaches the edit guard. This one warns and never reverts.

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { load } from "../config.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { ignoredPaths } from "./ignored-paths.mjs";
import { checkoutDirs, mayWrite } from "./shell-command.mjs";
import { isAllowed } from "./work-order-guard.mjs";
import { MANIFEST_FILE, readManifest } from "./work-order-manifest.mjs";
import { OFF, isolationSettings } from "./worktree-isolation.mjs";

const execFileAsync = promisify(execFile);
const slashed = (file) => file.split(path.sep).join("/");
const MAX_LISTED = 40;

/** The paths `git status --porcelain -z` names, with both sides of a rename. */
export function changedPaths(porcelain) {
  const fields = porcelain.split("\u0000");
  const paths = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R") paths.push(fields[++i]);
    else if (entry[0] === "C") i++;
  }
  return paths.filter(Boolean);
}

const native = (dir) => {
  try {
    return realpathSync.native(dir);
  } catch {
    return null;
  }
};

/** A directory as the command wrote it, resolved the way the shell would, or null when it does not exist. */
function resolveDir(cwd, dir) {
  let spelled = dir.replace(/^~(?=$|[\\/])/, os.homedir());
  if (process.platform === "win32") spelled = spelled.replace(/^\/([A-Za-z])(?=\/|$)/, "$1:");
  const absolute = path.resolve(cwd, spelled);
  return existsSync(absolute) ? absolute : null;
}

/** Every distinct checkout the command could have changed: its cwd, and each `cd` and `git -C` directory. */
function checkoutsOf(cwd, command) {
  const roots = new Set();
  for (const dir of [cwd, ...checkoutDirs(command).map((d) => resolveDir(cwd, d))]) {
    const root = dir && checkoutRootOf(dir);
    const real = root && native(root);
    if (real) roots.add(real);
  }
  return [...roots];
}

async function gitFacts(root) {
  const run = async (...args) => (await execFileAsync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout;
  const [status, branch] = await Promise.all([
    run("status", "--porcelain", "-z", "--untracked-files=all"),
    run("branch", "--show-current"),
  ]);
  return { changed: changedPaths(status), branch: branch.trim() };
}

/** @returns each changed path in one checkout that breaks a rule, with the rules it breaks. */
async function findingsIn(root, manifest, projectRoot) {
  let settings = null;
  try {
    settings = isolationSettings(load(root).swarm);
  } catch {
    // A config error is the edit guard's to name; this guard judges the declaration alone.
  }
  const guardsBranch = settings !== null && settings.require !== OFF;
  if (!manifest && !guardsBranch) return [];

  let facts;
  try {
    facts = await gitFacts(root);
  } catch {
    return [];
  }
  const rules = new Map();
  const add = (rel, rule) => rules.set(rel, [...(rules.get(rel) ?? []), rule]);

  const patterns = manifest?.paths ?? [];
  for (const rel of facts.changed) {
    if (!isAllowed(slashed(path.relative(projectRoot, path.join(root, rel))), patterns)) {
      add(rel, `outside the work order's declared paths (${MANIFEST_FILE}: ${patterns.join(", ")})`);
    }
  }
  if (guardsBranch && settings.protectedBranches.includes(facts.branch)) {
    const candidates = facts.changed.filter((rel) => !(settings.allow.length > 0 && isAllowed(rel, settings.allow)));
    const ignored = await ignoredPaths(root, candidates);
    for (const rel of candidates) {
      if (!ignored.has(rel)) add(rel, `changed on the protected branch "${facts.branch}"`);
    }
  }
  return [...rules].map(([rel, broken]) => `${slashed(root)}/${rel}: ${broken.join("; ")}`);
}

/**
 * The report on one finished Bash call. @param projectRoot the folder that holds the work-order manifest
 * @returns PostToolUse output with model-visible context, or null when nothing breaks a rule
 */
export async function report(call, projectRoot) {
  const command = call.tool_input?.command;
  if (typeof command !== "string" || !mayWrite(command)) return null;
  const cwd = call.cwd ?? process.cwd();
  const project = native(projectRoot) ?? projectRoot;

  let manifest = null;
  try {
    manifest = readManifest(project);
  } catch {
    // The edit guard names a manifest that does not parse.
  }
  const findings = [];
  for (const root of checkoutsOf(cwd, command)) findings.push(...(await findingsIn(root, manifest, project)));
  if (findings.length === 0) return null;

  const listed = findings.slice(0, MAX_LISTED).map((line) => `- ${line}`);
  if (findings.length > MAX_LISTED) listed.push(`- and ${findings.length - MAX_LISTED} more`);
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: [
        "Bash edit guard: this command left changes that the swarm rules do not allow. The guard does not revert them.",
        ...listed,
        "Revert each one, or ask the orchestrator before you keep it.",
      ].join("\n"),
    },
  };
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const isEntryPoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntryPoint) {
  let call = null;
  try {
    call = JSON.parse(await readStdin());
  } catch {
    // Not hook input, so there is no command to judge.
  }
  const output = call ? await report(call, process.env.CLAUDE_PROJECT_DIR ?? process.cwd()) : null;
  if (output) process.stdout.write(JSON.stringify(output));
}
