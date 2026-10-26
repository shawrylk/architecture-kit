import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const GUARD = fileURLToPath(new URL("./budget-guard.mjs", import.meta.url));

/** An adopted checkout with a budget, a linked worktree of it, a checkout with no config, and a temp folder for the counters. */
function workspace(t, swarm = { toolCallBudget: 3 }, config = {}) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-budget-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  const primary = path.join(base, "primary");
  const linked = path.join(base, "linked");
  const plain = path.join(base, "plain");
  const tmp = path.join(base, "tmp");
  for (const dir of [primary, plain, tmp]) mkdirSync(dir);
  git(primary, "init", "-q", "-b", "main");
  writeFileSync(path.join(primary, "qc.config.json"), JSON.stringify({ swarm, ...config }));
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

test("with no budget set, the guard counts nothing and stays silent", (t) => {
  const ws = workspace(t, {});
  assert.equal(runGuard(ws, callOf(ws.linked, "agent-1")), null);
  assert.equal(existsSync(ws.counters), false);
});

test("a budget of one hundred reminds at its seventieth call", (t) => {
  const ws = workspace(t, { toolCallBudget: 100 });
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

function mainCall(ws, tokens = 213_000) {
  const transcript = path.join(ws.tmp, "main.jsonl");
  const lines = [10_000, tokens].map((input_tokens) => ({
    type: "assistant", message: { usage: { input_tokens } },
  }));
  writeFileSync(transcript, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return { ...callOf(ws.linked, null), transcript_path: transcript };
}

test("the orchestrator gets the compaction note on its 5th call and not on the 4th", (t) => {
  const ws = workspace(t, { dispatch: {} });
  const call = mainCall(ws);
  for (let count = 1; count <= 4; count++) assert.equal(runGuard(ws, call), null);
  const output = runGuard(ws, call).hookSpecificOutput;
  assert.match(output.additionalContext, /Context budget: this session sends about 213K tokens per call, past budgets\.orchestrator\.compactAt \(200000\)\. Run \/compact/);
  assert.equal(output.permissionDecision, undefined);
  assert.equal(countOf(ws, "orchestrator"), 5);
  assert.equal(stateOf(ws, "orchestrator").budgetFiredAt, 5);
});

test("the note repeats only after 20 more calls", (t) => {
  const ws = workspace(t, { dispatch: {} });
  const call = mainCall(ws);
  for (let count = 1; count < 5; count++) runGuard(ws, call);
  const first = runGuard(ws, call);
  assert.match(noteOf(first), /Run \/compact/);
  for (let count = 6; count < 25; count++) assert.equal(runGuard(ws, call), null);
  assert.equal(stateOf(ws, "orchestrator").budgetFiredAt, 5);
  assert.deepEqual(runGuard(ws, call), first);
  assert.equal(stateOf(ws, "orchestrator").budgetFiredAt, 25);
});

test("a main session below compactAt gets nothing", (t) => {
  const ws = workspace(t, { dispatch: {} });
  const call = mainCall(ws, 199_999);
  for (let count = 1; count <= 5; count++) assert.equal(runGuard(ws, call), null);
  assert.equal(countOf(ws, "orchestrator"), 5);
});

test("budgets.orchestrator null gets nothing", (t) => {
  const ws = workspace(t, { dispatch: {} }, { budgets: { orchestrator: null } });
  const call = mainCall(ws);
  for (let count = 1; count <= 5; count++) assert.equal(runGuard(ws, call), null);
  assert.equal(existsSync(ws.counters), false);
});

test("with swarm.dispatch off the main session is not counted", (t) => {
  const ws = workspace(t);
  const call = mainCall(ws);
  for (let count = 1; count <= 5; count++) assert.equal(runGuard(ws, call), null);
  assert.equal(existsSync(ws.counters), false);
});

test("a main call with no transcript_path gets nothing and throws nothing", (t) => {
  const ws = workspace(t, { dispatch: {} });
  for (let count = 1; count <= 5; count++) assert.equal(runGuard(ws, callOf(ws.linked, null)), null);
});

test("main-session config and transcript errors leave the call alone", (t) => {
  const ws = workspace(t, { dispatch: {} });
  const call = mainCall(ws);
  call.transcript_path = path.join(ws.tmp, "missing.jsonl");
  for (let count = 1; count <= 5; count++) assert.equal(runGuard(ws, call), null);
  writeFileSync(path.join(ws.linked, "qc.config.json"), "{");
  assert.equal(runGuard(ws, call), null);
});

test("an implementer at the remind line gets one note", (t) => {
  const ws = workspace(t, { dispatch: {} });
  const call = signalCall(ws, transcripts(ws, "a1", [10_000, 110_000]));
  assert.match(noteOf(runGuard(ws, call)), /Context budget: .*finish the current item/i);
  assert.equal(runGuard(ws, call), null);
  assert.equal(stateOf(ws, "a1").budgetReminded, true);
  assert.equal(existsSync(ws.counters), false);
});

test("at handoffAt a non-hand-off call is denied and the hand-off still runs", (t) => {
  const ws = workspace(t, { dispatch: {}, toolCallBudget: 100, context: { every: 1 } });
  const main = transcripts(ws, "a1", [10_000, 160_000]);
  const output = runGuard(ws, signalCall(ws, main)).hookSpecificOutput;
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /HANDOFF: <note path>/);
  assert.equal(stateOf(ws, "a1").first, 10_000);
  assert.equal(stateOf(ws, "a1").budgetClosed, true);
  assert.equal(runGuard(ws, signalCall(ws, main, undefined, "Bash", { command: "git push" })), null);
  const handback = runGuard(ws, signalCall(ws, main, undefined, "SubagentHandback", { message: "HANDOFF: note" }));
  assert.match(handback.hookSpecificOutput.updatedInput.message, /CONTEXT:/);
  assert.equal(noteOf(handback), null);
  const lost = signalCall(ws, path.join(ws.tmp, "missing.jsonl"));
  assert.equal(runGuard(ws, lost).hookSpecificOutput.permissionDecision, "deny");
});

test("a reviewer at its handoffAt is denied with the report text", (t) => {
  const ws = workspace(t, { dispatch: {} });
  const main = transcripts(ws, "a1", [10_000, 120_000]);
  const output = runGuard(ws, signalCall(ws, main, "architecture:sdd-reviewer")).hookSpecificOutput;
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /VERDICT:.*UNREVIEWED:/);
  assert.doesNotMatch(output.permissionDecisionReason, /HANDOFF:/);
});

test("budgets.implementer null fires nothing", (t) => {
  const ws = workspace(t, { dispatch: {} }, { budgets: { implementer: null } });
  assert.equal(runGuard(ws, signalCall(ws, transcripts(ws, "a1", [10_000, 160_000]))), null);
  assert.equal(existsSync(ws.counters), false);
});

test("with swarm.dispatch off no role budget fires", (t) => {
  const ws = workspace(t, {});
  assert.equal(runGuard(ws, signalCall(ws, transcripts(ws, "a1", [10_000, 160_000]))), null);
});

test("swarm.toolCallBudget still denies when the context is small", (t) => {
  const ws = workspace(t, { dispatch: {}, toolCallBudget: 2 });
  const call = signalCall(ws, transcripts(ws, "a1", [10_000, 12_000]));
  runGuard(ws, call);
  assert.match(runGuard(ws, call).hookSpecificOutput.permissionDecisionReason, /call 2 of 2/);
  assert.equal(countOf(ws, "a1"), 2);
});

test("an agent with no transcript gets no deny", (t) => {
  const ws = workspace(t, { dispatch: {} });
  assert.equal(runGuard(ws, signalCall(ws, path.join(ws.tmp, "missing.jsonl"))), null);
  assert.equal(existsSync(ws.counters), false);
});

test("a bad budgets value gives one note and the tool-call budget still counts", (t) => {
  const ws = workspace(t, { dispatch: {}, toolCallBudget: 3 }, { budgets: { implementer: { remindAt: 0 } } });
  const call = signalCall(ws, transcripts(ws, "a1", [10_000, 160_000]));
  assert.match(noteOf(runGuard(ws, call)), /^Context budget is off: budgets\.implementer\.remindAt/);
  assert.equal(runGuard(ws, call), null);
  assert.match(runGuard(ws, call).hookSpecificOutput.permissionDecisionReason, /call 3 of 3/);
  assert.equal(countOf(ws, "a1"), 3);
});

test("the context signal and both budget reminders keep their notes and state", (t) => {
  const ws = workspace(t, { dispatch: {}, toolCallBudget: 1, context: { every: 1 } });
  const call = signalCall(ws, transcripts(ws, "a1", [10_000, 110_000]));
  assert.equal(runGuard(ws, call).hookSpecificOutput.permissionDecision, "deny");
  const combined = workspace(t, { dispatch: {}, toolCallBudget: 10, context: { every: 7 } });
  const combinedCall = signalCall(combined, transcripts(combined, "a1", [10_000, 12_000]));
  for (let index = 0; index < 6; index += 1) assert.equal(runGuard(combined, combinedCall), null);
  transcripts(combined, "a1", [10_000, 110_000]);
  const note = noteOf(runGuard(combined, combinedCall));
  assert.match(note, /Tool-call budget: this is call 7 of 10/);
  assert.match(note, /Context signal/);
  assert.match(note, /\nContext budget:/);
  assert.equal(stateOf(combined, "a1").first, 10_000);
  assert.equal(stateOf(combined, "a1").budgetReminded, true);
});

test("a role reminder on a hand-back adds no note", (t) => {
  const ws = workspace(t, { dispatch: {} });
  const main = transcripts(ws, "a1", [10_000, 110_000]);
  assert.equal(runGuard(ws, signalCall(ws, main, undefined, "SubagentHandback", { message: "DONE" })), null);
});

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

test("a small hand-back and `context: false` change nothing", (t) => {
  const ws = workspace(t, { toolCallBudget: 100, context: { every: 1 } });
  const small = transcripts(ws, "a1", [10_000, 12_000]);
  assert.equal(runGuard(ws, signalCall(ws, small, "architecture:sdd-reviewer", "SubagentHandback", { message: "DONE" })), null);
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

test("a budget deny stays a deny, and a large context adds no note to it", (t) => {
  const ws = workspace(t, { toolCallBudget: 3, context: { every: 3 } });
  const main = transcripts(ws, "a1", [10_000, 60_000]);
  runGuard(ws, signalCall(ws, main));
  runGuard(ws, signalCall(ws, main));
  const denied = runGuard(ws, signalCall(ws, main));
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /call 3 of 3/);
  assert.equal(noteOf(denied), null);
  assert.doesNotMatch(JSON.stringify(denied), /Context signal/);
});

test("a hand-back stamp replaces the budget reminder on the same call, because the agent is ending", (t) => {
  const ws = workspace(t, { toolCallBudget: 10, context: { every: 50 } });
  const main = transcripts(ws, "a1", [10_000, 60_000]);
  for (let index = 1; index < 7; index += 1) assert.equal(runGuard(ws, signalCall(ws, main)), null);
  const output = runGuard(ws, signalCall(ws, main, "architecture:sdd-reviewer", "SubagentHandback", { message: "DONE" }));
  assert.equal(countOf(ws, "a1"), 7, "call 7 of 10 is a reminder call");
  assert.match(output.hookSpecificOutput.updatedInput.message, /CONTEXT: this agent ended/);
  assert.equal(noteOf(output), null);
  assert.doesNotMatch(JSON.stringify(output), /Tool-call budget/);
});

const NO_TRANSCRIPT = /^Context signal is off for this agent: the hook input names no transcript for it\.$/;
const stateOf = (ws, agentId) => JSON.parse(readFileSync(path.join(ws.tmp, "architecture-kit", "context", `session-aaaa-${agentId}.json`), "utf8"));

test("a subagent call with no transcript gets the note once, and the next signal call gets none", (t) => {
  const ws = workspace(t, { toolCallBudget: 100, context: { every: 1 } });
  const lost = signalCall(ws, path.join(ws.tmp, "none", "x.jsonl"));
  assert.match(noteOf(runGuard(ws, lost)) ?? "", NO_TRANSCRIPT);
  assert.equal(runGuard(ws, lost), null);
  assert.equal(runGuard(ws, lost), null);
  assert.equal(stateOf(ws, "a1").noTranscript, true, "the state file records that the note fired");
});

test("an agent_transcript_path to a missing file falls back to the subagents path, then to the note", (t) => {
  const ws = workspace(t, { toolCallBudget: 100, context: { every: 1 } });
  const missing = path.join(ws.tmp, "none", "agent-a1.jsonl");
  const main = transcripts(ws, "a1", [10_000, 60_000]);
  const found = { ...signalCall(ws, main), agent_transcript_path: missing };
  assert.match(noteOf(runGuard(ws, found)) ?? "", /re-sends about 60K tokens/, "the subagents path is read");
  const none = path.join(ws.tmp, "none", "x.jsonl");
  assert.match(noteOf(runGuard(ws, { ...signalCall(ws, none), agent_transcript_path: missing })) ?? "", NO_TRANSCRIPT);
});

test("a hand-back with no transcript gets no stamp and no note, and leaves the note for a later signal call", (t) => {
  const ws = workspace(t, { toolCallBudget: 100, context: { every: 1 } });
  const none = path.join(ws.tmp, "none", "x.jsonl");
  assert.equal(runGuard(ws, signalCall(ws, none, "architecture:sdd-reviewer", "SubagentHandback", { message: "DONE" })), null);
  assert.match(noteOf(runGuard(ws, signalCall(ws, none))) ?? "", NO_TRANSCRIPT);
});

test("a main-session call with no transcript gets no note", (t) => {
  const ws = workspace(t, { toolCallBudget: 100, context: { every: 1 } });
  const { agent_id: _id, agent_type: _type, ...main } = signalCall(ws, path.join(ws.tmp, "none", "x.jsonl"));
  assert.equal(runGuard(ws, main), null);
  assert.equal(runGuard(ws, main), null);
});
