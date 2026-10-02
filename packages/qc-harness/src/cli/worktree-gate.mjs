#!/usr/bin/env node
// The Stop trigger of QC-015: a PR this session merged leaves no worktree, local branch, or remote branch on its
// head. It reads the merge records of the ledger, and runs git only for a merge of this session.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globMatcher } from "../glob.mjs";
import { fileSafe } from "./edit-batch-state.mjs";
import { readLedger } from "./ledger.mjs";
import { keyOf, worktrees } from "./worktree.mjs";
import { worktreeRuleAt } from "./worktree-settings.mjs";

const GIT_TIMEOUT_MS = 20_000;

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: GIT_TIMEOUT_MS });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim() };
}

/** The settled merges of this session, one per head branch, less each head that is long-lived by config. */
function mergesOf(records, session, config) {
  const longLived = globMatcher([...(config.swarm?.isolation?.protectedBranches ?? []), ...(config.branches?.allow ?? [])]);
  const byBranch = new Map();
  for (const record of records) {
    if (record.type !== "merge" || record.session !== session || record.pending || record.closed) continue;
    if (typeof record.branch === "string" && record.branch !== "" && !longLived(record.branch)) byBranch.set(record.branch, record);
  }
  return [...byBranch.values()];
}

/** The commands that remove what a merged head leaves, or none when nothing is left. */
function cleanupOf(merge, { main, folder }) {
  const { branch } = merge;
  const tree = worktrees(main).find((entry) => entry.branch === branch);
  const local = git(main, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`).ok;
  const remote = git(main, "ls-remote", "--heads", "origin", `refs/heads/${branch}`);
  const steps = [];
  if (tree && keyOf(tree.path) === keyOf(main)) steps.push(`\`git switch ${merge.base ?? "main"}\``, `\`git branch -D ${branch}\``);
  else if (tree && [folder, path.dirname(main)].some((parent) => keyOf(path.dirname(tree.path)) === keyOf(parent))) {
    // `remove` deletes the local branch, and the remote one at the head of a merged PR.
    return [`\`npx qc worktree remove ${path.basename(tree.path)}\``];
  } else if (tree) steps.push(`\`git worktree remove ${tree.path}\``, `\`git branch -D ${branch}\``);
  else if (local) steps.push(`\`git branch -D ${branch}\``);
  if (remote.ok && remote.out !== "") steps.push(`\`git push origin --delete ${branch}\``);
  return steps;
}

const memoryOf = (tmp, session) => path.join(tmp, "qc-worktree-gate", `${fileSafe(session)}.last`);
const hashOf = (text) => createHash("sha256").update(text).digest("hex");

function lastBlock(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The verdict on one Stop. @returns the hook output, or null to let the turn end with no message. */
export function decide(call, { tmp = os.tmpdir(), projectDir = process.env.CLAUDE_PROJECT_DIR } = {}) {
  if (call.hook_event_name !== "Stop") return null;
  const rule = worktreeRuleAt(call.cwd ?? process.cwd()) ?? (projectDir ? worktreeRuleAt(projectDir) : null);
  if (!rule) return null;
  const session = call.session_id ?? "session";
  let records;
  try {
    records = readLedger(rule.ledger);
  } catch {
    return null;
  }
  const lines = mergesOf(records, session, rule.config)
    .map((merge) => ({ merge, steps: cleanupOf(merge, rule) }))
    .filter(({ steps }) => steps.length > 0)
    .map(({ merge, steps }) => `- ${merge.repo}#${merge.pr} (${merge.branch}): ${steps.join(", then ")}`);
  const memory = memoryOf(tmp, session);
  if (lines.length === 0) {
    rmSync(memory, { force: true });
    return null;
  }
  const reason = [
    `Worktree check: a PR this session merged leaves its worktree or its branch. From the main checkout (${rule.main}), run:`,
    ...lines,
  ].join("\n");
  // A repeat stop with the same leftovers ends with a note, so a removal the agent cannot run never loops.
  const note = { systemMessage: `Worktree check: the same leftovers as at the last block remain. Remove them by hand: ${lines[0].slice(2)}` };
  if (call.stop_hook_active === true && lastBlock(memory) === hashOf(reason)) return note;
  try {
    mkdirSync(path.dirname(memory), { recursive: true });
    writeFileSync(memory, hashOf(reason));
  } catch {
    // With no memory, a repeat stop cannot tell a change, so it ends with the note.
    if (call.stop_hook_active === true) return note;
  }
  return { decision: "block", reason };
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
    // Not hook input, so there is no merge to follow up.
  }
  const output = call ? decide(call) : null;
  if (output) process.stdout.write(JSON.stringify(output));
}
