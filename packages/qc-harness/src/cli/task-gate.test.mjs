import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decide as dispatchDecide } from "./dispatch-guard.mjs";
import { appendRecord, readLedger } from "./ledger.mjs";
import { gitOut } from "./git-read.mjs";
import { continuedStop, gateRefusal, judgeTask, noResumeReason, recordDispatch, worktreeNamed } from "./task-gate.mjs";
import { sessionDirOf } from "./workflow-settings.mjs";

// The guard processes below run under Codex, whatever runtime runs the test.
process.env.QC_RUNTIME = "codex";

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
const implementerStop = (ws, head, branch = "feat/1-x", handoff = null) =>
  appendRecord(ws.ledger, {
    type: "stop",
    session: "s",
    agentType: "architecture:sdd-implementer",
    agentId: "a1",
    role: "implementer",
    branch,
    head,
    ...(handoff ? { handoff } : {}),
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

test("an implementer stop with no branch counts for no branch", (t) => {
  const ws = workspace(t);
  implementerStop(ws, commitIn(ws.linked, "b.txt"), null);
  assert.equal(refusalOf(ws), null);
});

test("a review that names another commit, before or after the stop, does not cover it", (t) => {
  const ws = workspace(t);
  const moved = commitIn(ws.linked, "b.txt");
  verdict(ws, "e".repeat(40));
  implementerStop(ws, moved);
  assert.match(refusalOf(ws) ?? "", /no review in the ledger/);
  verdict(ws, "d".repeat(40));
  assert.match(refusalOf(ws) ?? "", /no review in the ledger/);
  verdict(ws, moved);
  assert.equal(refusalOf(ws), null);
});

test("a review that names the stop head covers it wherever the ledger holds it", (t) => {
  const ws = workspace(t);
  const moved = commitIn(ws.linked, "b.txt");
  verdict(ws, moved);
  implementerStop(ws, moved);
  assert.equal(refusalOf(ws), null, "a verdict written before the stop");
  const other = commitIn(ws.linked, "c.txt");
  appendRecord(ws.ledger, { type: "verdict", kind: "task", verdict: "APPROVED", sha: other, branch: "feat/2-y" });
  implementerStop(ws, other);
  assert.equal(refusalOf(ws), null, "a verdict recorded under another branch name");
});

test("the gate spawns at most three git processes however long the ledger is", (t) => {
  const ws = workspace(t);
  const heads = Array.from({ length: 40 }, (_, index) => commitIn(ws.linked, `f${index}.txt`));
  for (const head of heads) implementerStop(ws, head);
  for (const head of heads.slice(0, 39)) verdict(ws, head);
  for (let index = 0; index < 40; index += 1) verdict(ws, String(index).repeat(40).slice(0, 40).padStart(40, "a"));
  const records = readLedger(ws.ledger);
  let spawns = 0;
  const git = (...args) => {
    spawns += 1;
    return gitOut(...args);
  };
  const call = () => gateRefusal({ records, branch: "feat/1-x", head: heads.at(-1), reason: null, type: "sdd-implementer", cwd: ws.linked, git });
  assert.match(call() ?? "", /no review in the ledger/);
  assert.ok(spawns >= 1 && spawns <= 3, `${spawns} git spawns`);
  verdict(ws, heads.at(-1));
  spawns = 0;
  assert.equal(gateRefusal({ records: readLedger(ws.ledger), branch: "feat/1-x", head: heads.at(-1), reason: null, type: "sdd-implementer", cwd: ws.linked, git }), null);
  assert.ok(spawns >= 1 && spawns <= 3, `${spawns} git spawns`);
});

test("a git error lets the dispatch pass", (t) => {
  const ws = workspace(t);
  const moved = commitIn(ws.linked, "b.txt");
  implementerStop(ws, moved);
  const records = readLedger(ws.ledger);
  assert.equal(gateRefusal({ records, branch: "feat/1-x", head: moved, reason: null, type: "sdd-implementer", cwd: ws.linked, git: () => null }), null);
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

test("the ancestry-path branch spawns at most three git processes, with a later review on a descendant", (t) => {
  const ws = workspace(t);
  const heads = Array.from({ length: 40 }, (_, index) => commitIn(ws.linked, `g${index}.txt`));
  implementerStop(ws, heads[10]);
  for (let index = 0; index < 40; index += 1) verdict(ws, String(index).repeat(40).slice(0, 40).padStart(40, "a"));
  verdict(ws, heads[20]);
  for (let index = 0; index < 40; index += 1) verdict(ws, String(index).repeat(40).slice(0, 40).padStart(40, "b"));
  const records = readLedger(ws.ledger);
  let spawns = 0;
  const git = (...args) => {
    spawns += 1;
    return gitOut(...args);
  };
  assert.equal(gateRefusal({ records, branch: "feat/1-x", head: heads.at(-1), reason: null, type: "sdd-implementer", cwd: ws.linked, git }), null);
  assert.ok(spawns >= 2 && spawns <= 3, `${spawns} git spawns, and the ancestry-path read must have run`);
  const unreviewed = [...records.slice(0, records.findIndex((r) => r.sha === heads[20])), ...records.slice(records.findIndex((r) => r.sha === heads[20]) + 1)];
  spawns = 0;
  assert.match(gateRefusal({ records: unreviewed, branch: "feat/1-x", head: heads.at(-1), reason: null, type: "sdd-implementer", cwd: ws.linked, git }) ?? "", /no review in the ledger/);
  assert.ok(spawns >= 2 && spawns <= 3, `${spawns} git spawns`);
});

/** A second repository with a linked worktree on feat/9-o. `on` turns its checks on. The primary checkout is the "cwd" repository. */
function otherRepo(ws, on) {
  const base = path.dirname(ws.main);
  const other = path.join(base, "other");
  git(base, "init", "-q", "-b", "main", other);
  for (const [key, value] of [["user.name", "qc"], ["user.email", "qc@example.com"], ["commit.gpgsign", "false"]]) {
    git(other, "config", key, value);
  }
  writeFileSync(path.join(other, "a.txt"), "a\n");
  if (on) writeFileSync(path.join(other, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {} } }));
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", "init");
  const linked = path.join(base, "other-linked");
  git(other, "worktree", "add", "-q", "-b", "feat/9-o", linked);
  return { other, linked, ledger: path.join(other, ".git", "qc", "ledger.jsonl") };
}

test("a worktree in another repository is judged by that repository's workflow and ledger", (t) => {
  const ws = workspace(t);
  const b = otherRepo(ws, true);
  const task = judgeTask(dispatch(ws.main, taskPrompt(b.linked)), ws.tmp);
  assert.equal(task.refusal, null);
  assert.equal(recordDispatch(task), null);
  assert.deepEqual(readLedger(b.ledger).map((record) => [record.type, record.task, record.branch]), [["dispatch", true, "feat/9-o"]]);
  assert.equal(existsSync(ws.ledger), false, "the cwd repository's ledger stays untouched");
  appendRecord(b.ledger, { type: "stop", session: "s", agentType: "architecture:sdd-implementer", agentId: "a9", role: "implementer", branch: "feat/9-o", head: commitIn(b.linked, "b.txt") });
  assert.match(judgeTask(dispatch(ws.main, taskPrompt(b.linked)), ws.tmp).refusal ?? "", /no review in the ledger/);
});

test("a worktree in a repository with no swarm workflow passes with a note and writes nothing", (t) => {
  const ws = workspace(t);
  const b = otherRepo(ws, false);
  const task = judgeTask(dispatch(ws.main, taskPrompt(b.linked)), ws.tmp);
  assert.equal(task.refusal, null);
  assert.match(task.note ?? "", /no swarm workflow/);
  assert.equal(task.record, null);
  assert.equal(recordDispatch(task), task.note);
  assert.equal(existsSync(b.ledger), false);
  assert.equal(existsSync(ws.ledger), false);
});

test("a reviewer dispatch records the worktree its prompt names, and is never refused", (t) => {
  const ws = workspace(t);
  implementerStop(ws, commitIn(ws.linked, "b.txt"));
  const task = judgeTask(dispatch(ws.main, taskPrompt(ws.linked), "architecture:sdd-reviewer"), ws.tmp);
  assert.equal(task.refusal, null);
  recordDispatch(task);
  const record = readLedger(ws.ledger).find((entry) => entry.type === "dispatch");
  assert.equal(record.task, false, "only an implementer dispatch is a task");
  assert.equal(record.agentType, "architecture:sdd-reviewer");
  assert.equal(record.branch, "feat/1-x");
  assert.equal(record.head, git(ws.linked, "rev-parse", "HEAD"));
  assert.equal(gitOut(record.worktree, "branch", "--show-current"), "feat/1-x");
});

test("a reviewer dispatch in another repository lands in that repository's ledger", (t) => {
  const ws = workspace(t);
  const b = otherRepo(ws, true);
  recordDispatch(judgeTask(dispatch(ws.main, taskPrompt(b.linked), "architecture:sdd-branch-reviewer"), ws.tmp));
  assert.deepEqual(readLedger(b.ledger).map((record) => [record.type, record.task, record.branch]), [["dispatch", false, "feat/9-o"]]);
  assert.equal(existsSync(ws.ledger), false);
});

test("a reviewer dispatch whose worktree does not exist passes and records no worktree", (t) => {
  const ws = workspace(t);
  const task = judgeTask(dispatch(ws.main, taskPrompt(path.join(ws.tmp, "nowhere")), "architecture:sdd-reviewer"), ws.tmp);
  assert.equal(task.refusal, null);
  assert.equal(task.record.worktree, null);
});

test("a worktree spelled as a Git Bash drive path resolves on Windows", { skip: process.platform !== "win32" }, (t) => {
  const ws = workspace(t);
  const gitBash = "/" + ws.linked.replace(/^([A-Za-z]):/, (_, drive) => drive.toLowerCase()).replaceAll("\\", "/");
  const task = judgeTask(dispatch(ws.main, taskPrompt(gitBash)), ws.tmp);
  assert.equal(task.refusal, null);
  assert.equal(task.record.branch, "feat/1-x");
});

test("a dispatch of a type that is no task type keeps its old behaviour when its prompt carries a Worktree line", (t) => {
  const ws = workspace(t);
  for (const on of [false, true]) {
    const b = otherRepo(ws, on);
    const task = judgeTask(dispatch(ws.main, taskPrompt(b.linked), "Explore"), ws.tmp);
    assert.equal(task.refusal, null);
    assert.equal(task.note, null);
    assert.equal(task.record.task, false);
    assert.equal(task.record.worktree, null);
    assert.equal(task.workflow.root, ws.main, "the cwd repository records it");
    rmSync(b.other, { recursive: true, force: true });
    rmSync(b.linked, { recursive: true, force: true });
  }
});

test("a Worktree line with a trailing parenthetical names its worktree", (t) => {
  const ws = workspace(t);
  const line = `${ws.linked.replaceAll(String.fromCharCode(92), "/")} (branch feat/1-x)`;
  const implementer = judgeTask(dispatch(ws.main, taskPrompt(line)), ws.tmp);
  assert.equal(implementer.refusal, null);
  assert.equal(implementer.record.task, true);
  assert.equal(implementer.record.branch, "feat/1-x");
  const reviewer = judgeTask(dispatch(ws.main, taskPrompt(line), "architecture:sdd-reviewer"), ws.tmp);
  assert.equal(reviewer.record.branch, "feat/1-x");
  assert.equal(gitOut(reviewer.record.worktree, "branch", "--show-current"), "feat/1-x");
});

test("the refusal for a worktree that does not exist quotes the path the prompt named", (t) => {
  const ws = workspace(t);
  const nowhere = path.join(ws.tmp, "nowhere");
  const refusal = judgeTask(dispatch(ws.main, taskPrompt(`${nowhere} (branch x)`)), ws.tmp).refusal ?? "";
  assert.ok(refusal.includes(`worktree "${nowhere}"`), refusal);
});

test("an implementer that edits qc.config.json in its worktree cannot turn its own review off", (t) => {
  const ws = workspace(t);
  writeFileSync(path.join(ws.linked, "qc.config.json"), JSON.stringify({ swarm: { toolCallBudget: 50 } }));
  implementerStop(ws, commitIn(ws.linked, "b.txt"));
  assert.match(refusalOf(ws) ?? "", /no review in the ledger/);
});

test("a fresh implementer with the HANDOFF line of the newest stop continues it without a review first", (t) => {
  const ws = workspace(t);
  const note = path.join(ws.tmp, "handoffs", "t1-1.md");
  const moved = commitIn(ws.linked, "b.txt");
  implementerStop(ws, moved, "feat/1-x", note);
  assert.match(refusalOf(ws) ?? "", /no review in the ledger names/);
  assert.match(refusalOf(ws) ?? "", /`HANDOFF: <note path>`/);
  assert.equal(refusalOf(ws, `HANDOFF: ${note}`), null);
  const { record } = judgeTask(dispatch(ws.main, taskPrompt(ws.linked, `HANDOFF: ${note}`)), ws.tmp);
  assert.equal(record.handoff, note);
});

test("the continuation's own stop needs a review, and a review of the later head covers both", (t) => {
  const ws = workspace(t);
  const note = path.join(ws.tmp, "handoffs", "t1-1.md");
  implementerStop(ws, commitIn(ws.linked, "b.txt"), "feat/1-x", note);
  const later = commitIn(ws.linked, "c.txt");
  implementerStop(ws, later);
  assert.match(refusalOf(ws, `HANDOFF: ${note}`) ?? "", /no review in the ledger names/);
  verdict(ws, later);
  assert.equal(refusalOf(ws), null);
});

test("a HANDOFF line of an older stop, of another branch, or of another note does not excuse a review", (t) => {
  const ws = workspace(t);
  const old = path.join(ws.tmp, "handoffs", "old.md");
  implementerStop(ws, commitIn(ws.linked, "b.txt"), "feat/1-x", old);
  implementerStop(ws, commitIn(ws.linked, "c.txt"));
  assert.match(refusalOf(ws, `HANDOFF: ${old}`) ?? "", /no review in the ledger names/);
  assert.match(refusalOf(ws, `HANDOFF: ${path.join(ws.tmp, "handoffs", "other.md")}`) ?? "", /no review in the ledger names/);
  assert.equal(continuedStop(readLedger(ws.ledger), "feat/2-y", old), null);
});

test("the newest stop of another branch with the named note is not a continuation of this branch", (t) => {
  const ws = workspace(t);
  const note = path.join(ws.tmp, "handoffs", "t1-1.md");
  implementerStop(ws, commitIn(ws.linked, "b.txt"));
  implementerStop(ws, "abc1234", "feat/2-y", note);
  assert.equal(continuedStop(readLedger(ws.ledger), "feat/1-x", note), null);
  assert.equal(continuedStop(readLedger(ws.ledger), "feat/2-y", note)?.branch, "feat/2-y");
});

test("after CHANGES_REQUIRED, a continuation of the fix round's hand-off needs no NO-RESUME line", (t) => {
  const ws = workspace(t);
  const reviewed = commitIn(ws.linked, "b.txt");
  implementerStop(ws, reviewed);
  verdict(ws, reviewed, "CHANGES_REQUIRED");
  const note = path.join(ws.tmp, "handoffs", "fix-1.md");
  const partial = commitIn(ws.linked, "c.txt");
  implementerStop(ws, partial, "feat/1-x", note);
  assert.match(refusalOf(ws) ?? "", /CHANGES_REQUIRED|no review/);
  assert.equal(refusalOf(ws, `HANDOFF: ${note}`), null);
});

test("a stop that a later CHANGES_REQUIRED reviewed is no longer continued by its HANDOFF line", (t) => {
  const ws = workspace(t);
  const note = path.join(ws.tmp, "handoffs", "t1-1.md");
  const stopped = commitIn(ws.linked, "b.txt");
  implementerStop(ws, stopped, "feat/1-x", note);
  assert.equal(refusalOf(ws, `HANDOFF: ${note}`), null);
  verdict(ws, stopped, "CHANGES_REQUIRED");
  assert.equal(continuedStop(readLedger(ws.ledger), "feat/1-x", note), null);
  assert.match(refusalOf(ws, `HANDOFF: ${note}`) ?? "", /CHANGES_REQUIRED/);
  assert.equal(refusalOf(ws, `HANDOFF: ${note}\nNO-RESUME: the budget is spent`), null);
});

test("a later verdict that names the stop's head ends the continuation, whatever branch it records", (t) => {
  const ws = workspace(t);
  const note = path.join(ws.tmp, "handoffs", "t1-1.md");
  const stopped = commitIn(ws.linked, "b.txt");
  implementerStop(ws, stopped, "feat/1-x", note);
  appendRecord(ws.ledger, { type: "verdict", kind: "task", verdict: "CHANGES_REQUIRED", sha: stopped });
  assert.equal(continuedStop(readLedger(ws.ledger), "feat/1-x", note), null);
  assert.match(refusalOf(ws, `HANDOFF: ${note}`) ?? "", /CHANGES_REQUIRED/);
});

test("a later verdict on the branch ends the continuation, whatever commit it names", (t) => {
  const ws = workspace(t);
  const note = path.join(ws.tmp, "handoffs", "t1-1.md");
  implementerStop(ws, commitIn(ws.linked, "b.txt"), "feat/1-x", note);
  verdict(ws, "abc1234", "CHANGES_REQUIRED");
  assert.equal(continuedStop(readLedger(ws.ledger), "feat/1-x", note), null);
  assert.match(refusalOf(ws, `HANDOFF: ${note}`) ?? "", /CHANGES_REQUIRED/);
});
