import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decide as dispatchDecide } from "./dispatch-guard.mjs";
import { appendRecord, readLedger } from "./ledger.mjs";
import { gateRefusal, judgeTask, noResumeReason, recordDispatch, worktreeNamed } from "./task-gate.mjs";
import { sessionDirOf } from "./workflow-settings.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

/** A checkout with the checks on and a linked worktree on feat/1-x, one without the checks, and a temp folder. */
function workspace(t) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-task-gate-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const main = path.join(base, "main");
  const off = path.join(base, "off");
  git(base, "init", "-q", "-b", "main", main);
  git(base, "init", "-q", "-b", "main", off);
  for (const [key, value] of [["user.name", "qc"], ["user.email", "qc@example.com"], ["commit.gpgsign", "false"]]) {
    git(main, "config", key, value);
  }
  writeFileSync(path.join(main, "a.txt"), "a\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  writeFileSync(path.join(main, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {} } }));
  writeFileSync(path.join(off, "qc.config.json"), JSON.stringify({ swarm: { toolCallBudget: 50 } }));
  const linked = path.join(base, "linked");
  git(main, "worktree", "add", "-q", "-b", "feat/1-x", linked);
  const tmp = path.join(base, "tmp");
  mkdirSync(tmp);
  return { main, off, linked, tmp, ledger: path.join(main, ".git", "qc", "ledger.jsonl") };
}

function commitIn(dir, name) {
  writeFileSync(path.join(dir, name), `${name}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", name);
  return git(dir, "rev-parse", "HEAD");
}

const dispatch = (cwd, prompt, subagent_type = "architecture:sdd-implementer", extra = {}) => ({
  session_id: "s",
  cwd,
  hook_event_name: "PreToolUse",
  tool_name: "Agent",
  tool_use_id: "toolu_1",
  tool_input: { subagent_type, description: "Task", prompt },
  ...extra,
});
const taskPrompt = (worktree, more = "") => `Read the brief at C:/scratch/brief.md.\nWorktree: ${worktree}\n${more}`;
const implementerStop = (ws, head, branch = "feat/1-x") =>
  appendRecord(ws.ledger, {
    type: "stop",
    session: "s",
    agentType: "architecture:sdd-implementer",
    agentId: "a1",
    role: "implementer",
    branch,
    head,
  });
const verdict = (ws, sha, value = "APPROVED", kind = "task") =>
  appendRecord(ws.ledger, { type: "verdict", kind, verdict: value, sha, branch: "feat/1-x" });
const refusalOf = (ws, more = "") => judgeTask(dispatch(ws.main, taskPrompt(ws.linked, more)), ws.tmp).refusal;

test("the prompt lines are read exactly", () => {
  assert.equal(worktreeNamed("x\n  Worktree:  C:/a b/wt  \ny"), "C:/a b/wt");
  assert.equal(worktreeNamed("worktree: /tmp/wt"), "/tmp/wt");
  assert.equal(worktreeNamed("Worktree: 'C:/a b/wt'\r\nmore"), "C:/a b/wt");
  assert.equal(worktreeNamed("the worktree is /tmp/wt"), null);
  assert.equal(noResumeReason("NO-RESUME: the budget is spent"), "the budget is spent");
  assert.equal(noResumeReason("no resume here"), null);
});

test("with swarm.dispatch off, the gate passes and writes nothing", (t) => {
  const ws = workspace(t);
  const task = judgeTask(dispatch(ws.off, taskPrompt(ws.linked)), ws.tmp);
  assert.equal(task.refusal, null);
  assert.equal(recordDispatch(task), null);
  assert.equal(existsSync(path.join(ws.off, ".git", "qc")), false);
});

test("a dispatch with no worktree line is recorded as no task, and the session remembers the checkout", (t) => {
  const ws = workspace(t);
  for (const call of [dispatch(ws.main, "Review the diff.", "architecture:sdd-reviewer"), dispatch(ws.main, "Read the brief.")]) {
    const task = judgeTask(call, ws.tmp);
    assert.equal(task.refusal, null);
    assert.equal(recordDispatch(task), null);
  }
  assert.deepEqual(readLedger(ws.ledger).map((record) => [record.type, record.task]), [["dispatch", false], ["dispatch", false]]);
  assert.ok(existsSync(path.join(sessionDirOf("s", ws.tmp), "state.json")));
});

test("a worktree line that names no linked worktree is refused, and the primary checkout never counts", (t) => {
  const ws = workspace(t);
  assert.match(judgeTask(dispatch(ws.main, taskPrompt(path.join(ws.tmp, "nowhere"))), ws.tmp).refusal ?? "", /no linked worktree/);
  assert.match(judgeTask(dispatch(ws.main, taskPrompt(ws.main)), ws.tmp).refusal ?? "", /no linked worktree/);
});

test("the first task on a branch passes and records its head", (t) => {
  const ws = workspace(t);
  const first = judgeTask(dispatch(ws.main, taskPrompt(ws.linked)), ws.tmp);
  assert.equal(first.refusal, null);
  recordDispatch(first);
  const [record] = readLedger(ws.ledger);
  assert.equal(record.task, true);
  assert.equal(record.branch, "feat/1-x");
  assert.equal(record.head, git(ws.linked, "rev-parse", "HEAD"));
});

test("an implementer commit with no review refuses the next implementer, until a review names it", (t) => {
  const ws = workspace(t);
  recordDispatch(judgeTask(dispatch(ws.main, taskPrompt(ws.linked)), ws.tmp));
  const moved = commitIn(ws.linked, "b.txt");
  implementerStop(ws, moved);
  assert.match(refusalOf(ws) ?? "", new RegExp(`no review in the ledger names ${moved.slice(0, 7)}`));
  verdict(ws, moved.slice(0, 7).toUpperCase());
  assert.equal(refusalOf(ws), null);
});

test("a stop at the current head needs a review even when the head has not moved since the dispatch", (t) => {
  const ws = workspace(t);
  implementerStop(ws, git(ws.linked, "rev-parse", "HEAD"));
  assert.match(refusalOf(ws) ?? "", /no review in the ledger/);
});

test("a controller commit after a reviewed implementer head needs no review", (t) => {
  const ws = workspace(t);
  recordDispatch(judgeTask(dispatch(ws.main, taskPrompt(ws.linked)), ws.tmp));
  const reviewed = commitIn(ws.linked, "b.txt");
  implementerStop(ws, reviewed);
  verdict(ws, reviewed);
  commitIn(ws.linked, "controller.txt");
  assert.equal(refusalOf(ws), null);
});

test("a moved head with no implementer stop on record needs no review", (t) => {
  const ws = workspace(t);
  recordDispatch(judgeTask(dispatch(ws.main, taskPrompt(ws.linked)), ws.tmp));
  commitIn(ws.linked, "controller.txt");
  assert.equal(refusalOf(ws), null);
});

test("a review of a later commit covers an earlier implementer stop", (t) => {
  const ws = workspace(t);
  implementerStop(ws, commitIn(ws.linked, "b.txt"));
  verdict(ws, commitIn(ws.linked, "c.txt"));
  assert.equal(refusalOf(ws), null);
});

test("an implementer stop on another branch, or off this history, is ignored", (t) => {
  const ws = workspace(t);
  implementerStop(ws, commitIn(ws.linked, "b.txt"), "feat/2-y");
  assert.equal(refusalOf(ws), null);
  implementerStop(ws, "f".repeat(40));
  assert.equal(refusalOf(ws), null);
});

test("after CHANGES_REQUIRED a fresh implementer is refused, unless the prompt says why a resume cannot work", (t) => {
  const ws = workspace(t);
  recordDispatch(judgeTask(dispatch(ws.main, taskPrompt(ws.linked)), ws.tmp));
  const moved = commitIn(ws.linked, "b.txt");
  implementerStop(ws, moved);
  verdict(ws, moved, "CHANGES_REQUIRED");
  assert.match(refusalOf(ws) ?? "", /NO-RESUME: <reason>/);
  const excused = judgeTask(dispatch(ws.main, taskPrompt(ws.linked, "NO-RESUME: its tool-call budget is spent")), ws.tmp);
  assert.equal(excused.refusal, null);
  recordDispatch(excused);
  assert.equal(readLedger(ws.ledger).at(-1).resumeReason, "its tool-call budget is spent");
});

test("a branch review that asks for changes blocks a fresh implementer until a NO-RESUME line", (t) => {
  const ws = workspace(t);
  verdict(ws, git(ws.linked, "rev-parse", "HEAD"), "CHANGES_REQUIRED", "branch");
  assert.match(refusalOf(ws) ?? "", /NO-RESUME: <reason>/);
  assert.equal(refusalOf(ws, "NO-RESUME: the resume ran out of context"), null);
});

test("a NO-RESUME line does not excuse an unreviewed implementer commit", (t) => {
  const ws = workspace(t);
  implementerStop(ws, commitIn(ws.linked, "b.txt"));
  assert.match(refusalOf(ws, "NO-RESUME: the resume ran out of context") ?? "", /no review in the ledger/);
});

test("gateRefusal passes when the ledger holds no implementer stop and no review asks for a fix", () => {
  const records = [{ type: "dispatch", task: true, branch: "feat/1-x", head: "a".repeat(40) }];
  assert.equal(gateRefusal({ records, branch: "feat/1-x", head: "b".repeat(40), reason: null, type: "sdd-implementer" }), null);
});

test("the worktree may be spelled with forward slashes, and on Windows in any case", (t) => {
  const ws = workspace(t);
  assert.equal(judgeTask(dispatch(ws.main, taskPrompt(ws.linked.replaceAll("\\", "/"))), ws.tmp).refusal, null);
  if (process.platform === "win32") {
    assert.equal(judgeTask(dispatch(ws.main, taskPrompt(ws.linked.toUpperCase())), ws.tmp).refusal, null);
  }
});

test("a subagent's own dispatch is left to its definition", (t) => {
  const ws = workspace(t);
  assert.equal(dispatchDecide(dispatch(ws.main, taskPrompt(ws.linked), "architecture:sdd-implementer", { agent_id: "agent-9" }), ws.tmp), null);
  assert.equal(existsSync(ws.ledger), false);
});

test("an implementer the task gate refuses holds no implementer slot", (t) => {
  const ws = workspace(t);
  recordDispatch(judgeTask(dispatch(ws.main, taskPrompt(ws.linked)), ws.tmp));
  implementerStop(ws, commitIn(ws.linked, "b.txt"));
  const output = dispatchDecide(dispatch(ws.main, taskPrompt(ws.linked), "architecture:sdd-implementer", { tool_use_id: "toolu_2" }), ws.tmp);
  assert.match(output?.hookSpecificOutput?.permissionDecisionReason ?? "", /^Task gate:/);
  const slots = path.join(ws.tmp, "architecture-kit", "dispatch");
  const claims = existsSync(slots) ? readdirSync(slots, { recursive: true }).filter((name) => String(name).endsWith(".claim")) : [];
  assert.deepEqual(claims, []);
});

test("the guard records an accepted task dispatch", (t) => {
  const ws = workspace(t);
  assert.equal(dispatchDecide(dispatch(ws.main, taskPrompt(ws.linked)), ws.tmp), null);
  assert.deepEqual(readLedger(ws.ledger).map((record) => [record.type, record.task, record.branch]), [["dispatch", true, "feat/1-x"]]);
});
