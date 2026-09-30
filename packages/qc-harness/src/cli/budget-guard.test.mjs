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

/** One subagent transcript in the layout Claude Code keeps, with one request per context size. @returns the main transcript path */
function transcripts(ws, agentId, contexts, prompt = "Read the brief.") {
  const project = path.join(ws.tmp, "projects", "p");
  const dir = path.join(project, "sess", "subagents");
  mkdirSync(dir, { recursive: true });
  const main = path.join(project, "sess.jsonl");
  writeFileSync(main, "");
  const lines = [
    { type: "user", message: { role: "user", content: prompt } },
    ...contexts.map((n, index) => ({
      type: "assistant",
      timestamp: new Date(index * 1000).toISOString(),
      message: { id: `m${index}`, model: "claude-sonnet-5-5", role: "assistant", content: [], usage: { input_tokens: 2, cache_read_input_tokens: n - 2, cache_creation_input_tokens: 0 } },
    })),
  ];
  writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return main;
}

const signalCall = (ws, main, agentType = "architecture:sdd-implementer", tool_name = "Bash", tool_input = { command: "npm test" }) => ({
  ...callOf(ws.linked, "a1", tool_name, tool_input),
  agent_type: agentType,
  transcript_path: main,
});
const noteOf = (output) => output?.hookSpecificOutput?.additionalContext ?? null;

test("a large implementer context gets the hand-off note once, and never a deny", (t) => {
  const ws = workspace(t, { toolCallBudget: 100, context: { every: 1 } });
  const main = transcripts(ws, "a1", [10_000, 60_000]);
  const first = runGuard(ws, signalCall(ws, main));
  assert.equal(first.hookSpecificOutput.permissionDecision, undefined);
  assert.match(noteOf(first), /re-sends about 60K tokens, 6\.0x its first call \(10K\)/);
  assert.match(noteOf(first), /`HANDOFF: <note path>`/);
  assert.equal(runGuard(ws, signalCall(ws, main)), null, "the same level does not fire twice in a row");
});

test("a reviewer, or a prompt estimate with few calls left, gets only the keep-it-small note", (t) => {
  const ws = workspace(t, { toolCallBudget: 100, context: { every: 1 } });
  const reviewer = runGuard(ws, signalCall(ws, transcripts(ws, "a1", [10_000, 60_000]), "architecture:sdd-reviewer"));
  assert.match(noteOf(reviewer), /line range/);
  assert.doesNotMatch(noteOf(reviewer), /HANDOFF/);
  const ws2 = workspace(t, { toolCallBudget: 100, context: { every: 1 } });
  const estimated = runGuard(ws2, signalCall(ws2, transcripts(ws2, "a1", [10_000, 60_000], "Brief: b.md\nEstimate: 12")));
  assert.doesNotMatch(noteOf(estimated), /HANDOFF/);
});

test("the check runs only every `every` calls", (t) => {
  const ws = workspace(t, { toolCallBudget: 100, context: { every: 3 } });
  const main = transcripts(ws, "a1", [10_000, 60_000]);
  assert.equal(runGuard(ws, signalCall(ws, main)), null);
  assert.equal(runGuard(ws, signalCall(ws, main)), null);
  assert.match(noteOf(runGuard(ws, signalCall(ws, main))) ?? "", /Context signal/);
});

test("a hand-back of a large agent gains a CONTEXT line through updatedInput", (t) => {
  const ws = workspace(t, { toolCallBudget: 100, context: { every: 50 } });
  const main = transcripts(ws, "a1", [10_000, 60_000]);
  const output = runGuard(ws, signalCall(ws, main, "architecture:sdd-reviewer", "SubagentHandback", { message: "VERDICT: APPROVED abc1234" }));
  assert.equal(output.hookSpecificOutput.permissionDecision, "allow");
  assert.match(output.hookSpecificOutput.updatedInput.message, /^VERDICT: APPROVED abc1234\n\nCONTEXT: this agent ended at about 60K tokens per call/);
});

test("a small hand-back, a missing transcript, and `context: false` change nothing", (t) => {
  const ws = workspace(t, { toolCallBudget: 100, context: { every: 1 } });
  const small = transcripts(ws, "a1", [10_000, 12_000]);
  assert.equal(runGuard(ws, signalCall(ws, small, "architecture:sdd-reviewer", "SubagentHandback", { message: "DONE" })), null);
  assert.equal(runGuard(ws, signalCall(ws, path.join(ws.tmp, "none", "x.jsonl"))), null);
  const off = workspace(t, { toolCallBudget: 100, context: false });
  assert.equal(runGuard(off, signalCall(off, transcripts(off, "a1", [10_000, 60_000]))), null);
});

test("a wrong context key is reported as context at a check, and the budget still counts", (t) => {
  const ws = workspace(t, { toolCallBudget: 100, context: { every: 0 } });
  const main = transcripts(ws, "a1", [10_000, 60_000]);
  for (let index = 1; index < 5; index += 1) assert.equal(runGuard(ws, signalCall(ws, main)), null);
  assert.match(noteOf(runGuard(ws, signalCall(ws, main))) ?? "", /Context signal is off: swarm\.context\.every/);
  assert.equal(countOf(ws, "a1"), 5);
});

test("the budget reminder and the context note share one additionalContext", (t) => {
  const ws = workspace(t, { toolCallBudget: 10, context: { every: 7 } });
  const main = transcripts(ws, "a1", [10_000, 60_000]);
  let output = null;
  for (let index = 0; index < 7; index += 1) output = runGuard(ws, signalCall(ws, main));
  assert.match(noteOf(output), /Tool-call budget: this is call 7 of 10/);
  assert.match(noteOf(output), /Context signal/);
});
