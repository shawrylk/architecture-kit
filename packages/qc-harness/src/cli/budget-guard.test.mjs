import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const GUARD = fileURLToPath(new URL("./budget-guard.mjs", import.meta.url));

/** An adopted checkout with a budget, a linked worktree of it, a checkout with no config, and a temp folder for the counters. */
function workspace(t, swarm = { toolCallBudget: 3 }) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-budget-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  const primary = path.join(base, "primary");
  const linked = path.join(base, "linked");
  const plain = path.join(base, "plain");
  const tmp = path.join(base, "tmp");
  for (const dir of [primary, plain, tmp]) mkdirSync(dir);
  git(primary, "init", "-q", "-b", "main");
  writeFileSync(path.join(primary, "qc.config.json"), JSON.stringify({ swarm }));
  git(primary, "add", ".");
  git(primary, "-c", "user.name=qc", "-c", "user.email=qc@example.com", "commit", "-q", "-m", "init");
  git(primary, "worktree", "add", "-q", linked, "-b", "feat/work-order");
  git(plain, "init", "-q", "-b", "main");
  mkdirSync(path.join(linked, "src"));
  return { primary, linked, plain, tmp, counters: path.join(tmp, "architecture-kit", "budget") };
}

const callOf = (cwd, agentId, tool_name = "Bash", tool_input = { command: "npm test" }) => ({
  session_id: "session-aaaa",
  ...(agentId ? { agent_id: agentId, agent_type: "general-purpose" } : {}),
  cwd,
  hook_event_name: "PreToolUse",
  tool_name,
  tool_input,
});

/** Runs the hook as its own process, with every temp-folder variable pinned to the test's folder. */
function runGuard(ws, call) {
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(call),
    env: { ...process.env, TEMP: ws.tmp, TMP: ws.tmp, TMPDIR: ws.tmp },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() === "" ? null : JSON.parse(result.stdout);
}

const countOf = (ws, agentId) => JSON.parse(readFileSync(path.join(ws.counters, `session-aaaa-${agentId}.json`), "utf8")).count;

test("the main session has no agent id, so it is never counted", (t) => {
  const ws = workspace(t);
  for (let i = 0; i < 4; i++) assert.equal(runGuard(ws, callOf(ws.linked, null)), null);
  assert.equal(existsSync(ws.counters), false);
});

test("a repository with no qc.config.json is never counted", (t) => {
  const ws = workspace(t);
  for (let i = 0; i < 4; i++) assert.equal(runGuard(ws, callOf(ws.plain, "agent-1")), null);
  assert.equal(existsSync(ws.counters), false);
});

test("each agent of one session keeps its own count", (t) => {
  const ws = workspace(t, { toolCallBudget: 50 });
  runGuard(ws, callOf(ws.linked, "agent-1"));
  runGuard(ws, callOf(ws.linked, "agent-1"));
  runGuard(ws, callOf(ws.linked, "agent-2"));
  assert.equal(countOf(ws, "agent-1"), 2);
  assert.equal(countOf(ws, "agent-2"), 1);
});

test("in a linked worktree, the budget from qc.config.json denies the call that reaches it, and the hand-off still runs", (t) => {
  const ws = workspace(t);
  assert.equal(runGuard(ws, callOf(path.join(ws.linked, "src"), "agent-1")), null);
  assert.equal(runGuard(ws, callOf(ws.linked, "agent-1")), null);
  const denied = runGuard(ws, callOf(ws.linked, "agent-1"));
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /call 3 of 3/);
  assert.equal(runGuard(ws, callOf(ws.linked, "agent-1", "Bash", { command: "git push" })), null);
});

test("the default budget reminds at its seventieth call", (t) => {
  const ws = workspace(t, {});
  mkdirSync(ws.counters, { recursive: true });
  writeFileSync(path.join(ws.counters, "session-aaaa-agent-1.json"), JSON.stringify({ count: 69 }));
  const output = runGuard(ws, callOf(ws.linked, "agent-1"));
  assert.match(output.hookSpecificOutput.additionalContext, /call 70 of 100/);
});
