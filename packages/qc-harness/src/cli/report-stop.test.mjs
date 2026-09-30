import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { appendRecord, readLedger } from "./ledger.mjs";
import { branchOf, decide, verdictOf } from "./report-stop.mjs";
import { judgeTask } from "./task-gate.mjs";
import { rememberSession } from "./workflow-settings.mjs";

const HOOK = fileURLToPath(new URL("./report-stop.mjs", import.meta.url));
const AGENTS = fileURLToPath(new URL("../../../../agents/", import.meta.url));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

/** A checkout with the checks on and a branch feat/1-x at its head, a plain checkout, a folder outside, and a temp folder. */
function workspace(t) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-report-stop-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const on = path.join(base, "on");
  const plain = path.join(base, "plain");
  git(base, "init", "-q", "-b", "main", on);
  git(base, "init", "-q", "-b", "main", plain);
  for (const [key, value] of [["user.name", "qc"], ["user.email", "qc@example.com"], ["commit.gpgsign", "false"]]) {
    git(on, "config", key, value);
  }
  writeFileSync(path.join(on, "a.txt"), "a\n");
  git(on, "add", ".");
  git(on, "commit", "-q", "-m", "init");
  git(on, "branch", "feat/1-x");
  writeFileSync(path.join(on, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {} } }));
  const outside = path.join(base, "outside");
  const tmp = path.join(base, "tmp");
  mkdirSync(outside);
  mkdirSync(tmp);
  return { on, plain, outside, tmp, head: git(on, "rev-parse", "HEAD"), ledger: path.join(on, ".git", "qc", "ledger.jsonl") };
}

const handback = (cwd, agentType, message, event = "PreToolUse") => ({
  session_id: "s",
  cwd,
  hook_event_name: event,
  tool_name: "SubagentHandback",
  tool_input: { message },
  agent_id: "agent-1",
  agent_type: agentType,
});
const stop = (cwd, agentType, last, extra = {}) => ({
  session_id: "s",
  cwd,
  hook_event_name: "SubagentStop",
  agent_id: "agent-1",
  agent_type: agentType,
  last_assistant_message: last,
  stop_hook_active: false,
  ...extra,
});

/** Writes the transcript of one subagent, whose first message is its dispatch prompt. @returns the file path. */
function transcript(ws, name, prompt) {
  const file = path.join(ws.tmp, `${name}.jsonl`);
  const lines = [
    { type: "user", isSidechain: true, message: { role: "user", content: prompt } },
    { type: "assistant", message: { role: "assistant", content: "ok" } },
  ];
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return file;
}
const namesWorktree = (ws, name, worktree) => ({ agent_transcript_path: transcript(ws, name, `Read the brief.\nWorktree: ${worktree}\nGo.`) });
const denied = (output) => output?.hookSpecificOutput?.permissionDecisionReason ?? null;

test("with swarm.dispatch off, or for another agent type, nothing is judged or written", (t) => {
  const ws = workspace(t);
  assert.equal(decide(handback(ws.plain, "architecture:sdd-reviewer", "no verdict"), ws.tmp), null);
  assert.equal(decide(stop(ws.plain, "architecture:sdd-implementer", "done"), ws.tmp), null);
  assert.equal(decide(stop(ws.on, "Explore", "done"), ws.tmp), null);
  assert.equal(existsSync(ws.ledger), false);
});

test("the verdict is read from the first non-blank line only", () => {
  assert.deepEqual(verdictOf("\n  VERDICT: APPROVED ABC1234\nbody"), { verdict: "APPROVED", sha: "abc1234" });
  assert.equal(verdictOf("Summary\nVERDICT: APPROVED abc1234"), null);
  assert.equal(verdictOf("VERDICT: LGTM abc1234"), null);
  assert.equal(verdictOf("VERDICT: APPROVED abc12"), null);
});

test("a reviewer hand-back without its verdict line, or with a sha the repository lacks, is refused", (t) => {
  const ws = workspace(t);
  assert.match(denied(decide(handback(ws.on, "architecture:sdd-reviewer", "Looks fine."), ws.tmp)) ?? "", /VERDICT: APPROVED <sha>/);
  const named = namesWorktree(ws, "r1", ws.on);
  assert.match(
    denied(decide({ ...handback(ws.on, "architecture:sdd-branch-reviewer", "VERDICT: APPROVED deadbee"), ...named }, ws.tmp)) ?? "",
    /deadbee names no commit/,
  );
});

test("a task APPROVED needs a RED-CHECKED line, and CHANGES_REQUIRED does not", (t) => {
  const ws = workspace(t);
  const sha = ws.head.slice(0, 7);
  assert.match(denied(decide(handback(ws.on, "architecture:sdd-reviewer", `VERDICT: APPROVED ${sha}`), ws.tmp)) ?? "", /RED-CHECKED:/);
  assert.equal(decide(handback(ws.on, "architecture:sdd-reviewer", `VERDICT: CHANGES_REQUIRED ${sha}\nfix x`), ws.tmp), null);
  assert.equal(decide(handback(ws.on, "architecture:sdd-branch-reviewer", `VERDICT: APPROVED ${sha}`), ws.tmp), null);
});

test("a kept hand-back lets the stop pass on closing text, and records the verdict with its full sha and branch", (t) => {
  const ws = workspace(t);
  const message = `VERDICT: APPROVED ${ws.head.slice(0, 8).toUpperCase()}\nRED-CHECKED: the test failed at abc before the fix`;
  assert.equal(decide(handback(ws.on, "architecture:sdd-reviewer", message), ws.tmp), null);
  assert.equal(decide(handback(ws.on, "architecture:sdd-reviewer", message, "PostToolUse"), ws.tmp), null);
  assert.equal(decide(stop(ws.on, "architecture:sdd-reviewer", "Report sent."), ws.tmp), null);
  const [stopRecord, verdict] = readLedger(ws.ledger);
  assert.equal(stopRecord.type, "stop");
  assert.equal(stopRecord.role, "task");
  assert.deepEqual(
    { type: verdict.type, kind: verdict.kind, verdict: verdict.verdict, sha: verdict.sha, branch: verdict.branch, redChecked: verdict.redChecked },
    { type: "verdict", kind: "task", verdict: "APPROVED", sha: ws.head, branch: "feat/1-x", redChecked: true },
  );
  assert.equal(decide(stop(ws.on, "architecture:sdd-reviewer", "Report sent."), ws.tmp)?.decision, "block", "the kept report is dropped");
});

test("a reviewer stop with no hand-back and no verdict line is blocked", (t) => {
  const ws = workspace(t);
  const output = decide(stop(ws.on, "sdd-branch-reviewer", "All good."), ws.tmp);
  assert.equal(output.decision, "block");
  assert.match(output.reason, /VERDICT: APPROVED <sha>/);
  assert.equal(existsSync(ws.ledger), false);
});

test("an implementer report needs a RED line and a GREEN line", (t) => {
  const ws = workspace(t);
  assert.match(denied(decide(handback(ws.on, "architecture:sdd-implementer", "DONE\nGREEN: 5 pass"), ws.tmp)) ?? "", /RED:/);
  const blocked = decide(stop(ws.on, "sdd-implementer", "DONE\nRED: node --test x: 1 fail"), ws.tmp);
  assert.equal(blocked.decision, "block");
  assert.match(blocked.reason, /GREEN:/);
  const passed = decide(stop(ws.on, "sdd-implementer", "DONE\nRED: node --test x: 1 fail\nGREEN: node --test x: 1 pass"), ws.tmp);
  assert.equal(passed.decision, undefined);
  assert.match(passed.systemMessage, /Worktree:.*records no head/);
  assert.deepEqual(readLedger(ws.ledger).map((record) => [record.type, record.role]), [["stop", "implementer"]]);
});

test("a stop whose cwd holds no config uses the checkout its session remembered", (t) => {
  const ws = workspace(t);
  assert.equal(decide(stop(ws.outside, "sdd-branch-reviewer", "All good."), ws.tmp), null);
  rememberSession("s", ws.on, ws.tmp);
  assert.equal(decide(stop(ws.outside, "sdd-branch-reviewer", "All good."), ws.tmp)?.decision, "block");
});

test("the agent definitions ask for the lines the hook checks", () => {
  const read = (name) => readFileSync(path.join(AGENTS, `${name}.md`), "utf8");
  assert.match(read("sdd-implementer"), /`RED:`/);
  assert.match(read("sdd-implementer"), /`GREEN:`/);
  assert.match(read("sdd-reviewer"), /VERDICT: APPROVED <sha>/);
  assert.match(read("sdd-reviewer"), /`RED-CHECKED:`/);
  assert.match(read("sdd-branch-reviewer"), /VERDICT: APPROVED <sha>/);
});

test("the hook process is silent in a checkout without the checks", (t) => {
  const ws = workspace(t);
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(stop(ws.plain, "sdd-implementer", "done")),
    env: { ...process.env, TEMP: ws.tmp, TMP: ws.tmp, TMPDIR: ws.tmp },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

/** A linked worktree of `ws.on` on feat/2-y with one commit more; feat/3-z names that commit but is checked out nowhere. */
function linkedTask(ws, t) {
  const linked = path.join(path.dirname(ws.on), "linked");
  git(ws.on, "worktree", "add", "-q", "-b", "feat/2-y", linked);
  writeFileSync(path.join(linked, "b.txt"), "b\n");
  git(linked, "add", ".");
  git(linked, "-c", "user.name=qc", "-c", "user.email=qc@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "b");
  git(ws.on, "branch", "feat/3-z", "feat/2-y");
  appendRecord(ws.ledger, {
    type: "dispatch",
    session: "s",
    agentType: "architecture:sdd-implementer",
    task: true,
    worktree: linked,
    branch: "feat/2-y",
    head: ws.head,
  });
  return { linked, head: git(linked, "rev-parse", "HEAD") };
}

const REPORT = "DONE\nRED: node --test x: 1 fail\nGREEN: node --test x: 1 pass";

test("an implementer stop records the full head and the branch of the worktree its own prompt names", (t) => {
  const ws = workspace(t);
  const { head, linked } = linkedTask(ws, t);
  assert.equal(decide(stop(ws.on, "architecture:sdd-implementer", REPORT, namesWorktree(ws, "i1", linked)), ws.tmp), null);
  const record = readLedger(ws.ledger).find((entry) => entry.type === "stop");
  assert.equal(record.head, head);
  assert.equal(record.branch, "feat/2-y");
  assert.equal(record.worktree, linked);
  assert.equal(record.agentId, "agent-1");
});

test("an implementer stop whose prompt names no worktree writes no head and no branch, and says so", (t) => {
  const ws = workspace(t);
  linkedTask(ws, t);
  assert.match(decide(stop(ws.on, "architecture:sdd-implementer", REPORT), ws.tmp)?.systemMessage ?? "", /records no head/);
  const record = readLedger(ws.ledger).find((entry) => entry.type === "stop");
  assert.equal(record.head, undefined);
  assert.equal(record.branch, undefined);
});

test("a verdict on a commit several branches name takes the branch the dispatch's worktree has checked out", (t) => {
  const ws = workspace(t);
  const { head, linked } = linkedTask(ws, t);
  git(linked, "checkout", "-q", "feat/3-z");
  assert.equal(decide(stop(ws.on, "architecture:sdd-reviewer", `VERDICT: CHANGES_REQUIRED ${head}\nfix x`), ws.tmp), null);
  assert.equal(readLedger(ws.ledger).find((entry) => entry.type === "verdict").branch, "feat/3-z");
});

const REVIEWER = "architecture:sdd-reviewer";
const IMPLEMENTER = "architecture:sdd-implementer";

test("a stop that a block already held once ends with a message, and records nothing", (t) => {
  const ws = workspace(t);
  const held = { stop_hook_active: true };
  const reviewer = decide(stop(ws.on, "sdd-branch-reviewer", "All good.", held), ws.tmp);
  assert.equal(reviewer.decision, undefined);
  assert.match(reviewer.systemMessage, /VERDICT: APPROVED <sha>/);
  const implementer = decide(stop(ws.on, "sdd-implementer", "DONE", held), ws.tmp);
  assert.equal(implementer.decision, undefined);
  assert.match(implementer.systemMessage, /RED:/);
  assert.equal(existsSync(ws.ledger), false);
});

test("the retry after a block records the verdict once the report is fixed", (t) => {
  const ws = workspace(t);
  const message = `VERDICT: APPROVED ${ws.head.slice(0, 8)}\nRED-CHECKED: the test failed before the fix`;
  assert.equal(decide(stop(ws.on, REVIEWER, "All good."), ws.tmp)?.decision, "block");
  assert.equal(decide(handback(ws.on, REVIEWER, message), ws.tmp), null);
  assert.equal(decide(handback(ws.on, REVIEWER, message, "PostToolUse"), ws.tmp), null);
  assert.equal(decide(stop(ws.on, REVIEWER, "Sent.", { stop_hook_active: true }), ws.tmp), null);
  assert.deepEqual(
    readLedger(ws.ledger).map((record) => [record.type, record.sha ?? null]),
    [["stop", null], ["verdict", ws.head]],
  );
});

test("a git failure reading the sha passes with a note, and the verdict keeps the sha the reviewer wrote", (t) => {
  const ws = workspace(t);
  const failing = { commit: () => ({ error: "git timed out after 10000 ms" }) };
  const message = `VERDICT: APPROVED ${ws.head.slice(0, 8).toUpperCase()}\nRED-CHECKED: the test failed before the fix`;
  const pre = decide(handback(ws.on, REVIEWER, message), ws.tmp, failing);
  assert.equal(pre.hookSpecificOutput.permissionDecision, undefined);
  assert.match(pre.hookSpecificOutput.additionalContext, /timed out/);
  decide(handback(ws.on, REVIEWER, message, "PostToolUse"), ws.tmp, failing);
  const output = decide(stop(ws.on, REVIEWER, "Sent."), ws.tmp, failing);
  assert.equal(output.decision, undefined);
  assert.match(output.systemMessage, /timed out/);
  const verdict = readLedger(ws.ledger).find((record) => record.type === "verdict");
  assert.equal(verdict.sha, ws.head.slice(0, 8));
  assert.equal(verdict.branch, null);
});

test("a sha the cwd repository lacks, with no worktree named, passes with a note and records no verdict", (t) => {
  const ws = workspace(t);
  const message = "VERDICT: APPROVED deadbee\nRED-CHECKED: the test failed before the fix";
  const pre = decide(handback(ws.on, REVIEWER, message), ws.tmp);
  assert.equal(pre.hookSpecificOutput.permissionDecision, undefined);
  assert.match(pre.hookSpecificOutput.additionalContext, /deadbee names no commit in/);
  decide(handback(ws.on, REVIEWER, message, "PostToolUse"), ws.tmp);
  assert.match(decide(stop(ws.on, REVIEWER, "Sent."), ws.tmp)?.systemMessage ?? "", /not recorded/);
  assert.deepEqual(readLedger(ws.ledger).map((record) => record.type), ["stop"]);
});

/** A linked worktree of ws.on on `branch`, dispatched at its first head, with one commit more unless `commit` is false. */
function taskWorktree(ws, name, branch, { commit = true } = {}) {
  const dir = path.join(path.dirname(ws.on), name);
  git(ws.on, "worktree", "add", "-q", "-b", branch, dir);
  const base = git(dir, "rev-parse", "HEAD");
  appendRecord(ws.ledger, { type: "dispatch", session: "s", agentType: IMPLEMENTER, task: true, worktree: dir, branch, head: base });
  if (commit) commitMore(dir, `${name}-1.txt`);
  return { dir, base, branch };
}
function commitMore(dir, file) {
  writeFileSync(path.join(dir, file), `${file}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", file);
  return git(dir, "rev-parse", "HEAD");
}
const stopsOf = (ws) => readLedger(ws.ledger).filter((record) => record.type === "stop");

test("two implementers dispatched in parallel each record their own worktree, whichever stops first", (t) => {
  const ws = workspace(t);
  const a = taskWorktree(ws, "wt-a", "feat/a-1");
  const b = taskWorktree(ws, "wt-b", "feat/b-1");
  const stopFor = (id, place, name) => stop(ws.on, IMPLEMENTER, REPORT, { agent_id: id, ...namesWorktree(ws, name, place.dir) });
  assert.equal(decide(stopFor("agent-A", a, "ta"), ws.tmp), null);
  assert.equal(decide(stopFor("agent-B", b, "tb"), ws.tmp), null);
  const [stopA, stopB] = stopsOf(ws);
  assert.deepEqual([stopA.agentId, stopA.worktree, stopA.branch, stopA.head], ["agent-A", a.dir, "feat/a-1", git(a.dir, "rev-parse", "HEAD")]);
  assert.deepEqual([stopB.agentId, stopB.worktree, stopB.branch, stopB.head], ["agent-B", b.dir, "feat/b-1", git(b.dir, "rev-parse", "HEAD")]);
});

test("a resumed implementer keeps its worktree after another dispatch, and needs no transcript to do it", (t) => {
  const ws = workspace(t);
  const a = taskWorktree(ws, "wt-a", "feat/a-1");
  decide(stop(ws.on, IMPLEMENTER, REPORT, { agent_id: "agent-A", ...namesWorktree(ws, "ta", a.dir) }), ws.tmp);
  taskWorktree(ws, "wt-b", "feat/b-1");
  const fixed = commitMore(a.dir, "fix.txt");
  assert.equal(decide(stop(ws.on, IMPLEMENTER, REPORT, { agent_id: "agent-A" }), ws.tmp), null);
  const second = stopsOf(ws).at(-1);
  assert.deepEqual([second.worktree, second.branch, second.head], [a.dir, "feat/a-1", fixed]);
});

test("a stop with no new commit writes a worktree and a branch but no head, so it needs no review", (t) => {
  const ws = workspace(t);
  const a = taskWorktree(ws, "wt-a", "feat/a-1", { commit: false });
  appendRecord(ws.ledger, { type: "verdict", kind: "task", verdict: "APPROVED", sha: a.base, branch: a.branch });
  const blocked = "BLOCKED: the brief is missing\nRED: node --test x: 1 fail\nGREEN: node --test x: 1 pass";
  assert.equal(decide(stop(ws.on, IMPLEMENTER, blocked, namesWorktree(ws, "ta", a.dir)), ws.tmp), null);
  const [record] = stopsOf(ws);
  assert.deepEqual([record.worktree, record.branch, record.head], [a.dir, "feat/a-1", undefined]);
  const again = judgeTask(
    {
      session_id: "s",
      cwd: ws.on,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: IMPLEMENTER, description: "t", prompt: `Worktree: ${a.dir}` },
    },
    ws.tmp,
  );
  assert.equal(again.refusal, null);
});

test("a reviewer verdict takes the branch its own worktree has checked out, not the newest dispatch's", (t) => {
  const ws = workspace(t);
  const { head, linked } = linkedTask(ws, t);
  git(ws.on, "branch", "feat/4-w", head);
  const decoy = path.join(path.dirname(ws.on), "decoy");
  git(ws.on, "worktree", "add", "-q", decoy, "feat/4-w");
  appendRecord(ws.ledger, { type: "dispatch", session: "s", agentType: IMPLEMENTER, task: true, worktree: decoy, branch: "feat/4-w", head });
  git(linked, "checkout", "-q", "feat/3-z");
  assert.equal(decide(stop(ws.on, REVIEWER, `VERDICT: CHANGES_REQUIRED ${head}\nfix x`, namesWorktree(ws, "rv", linked)), ws.tmp), null);
  const verdict = readLedger(ws.ledger).find((record) => record.type === "verdict");
  assert.equal(verdict.branch, "feat/3-z");
  assert.equal(stopsOf(ws)[0].worktree, linked);
});

test("branchOf probes each dispatched worktree once and never more than ten", () => {
  const dispatches = Array.from({ length: 60 }, (_, index) => ({ worktree: `/w/${index % 25}` }));
  const probes = [];
  const at = {
    branchesAt: () => ["feat/x", "feat/y"],
    branchAt: (dir) => {
      probes.push(dir);
      return null;
    },
  };
  assert.equal(branchOf({ root: "/r", protectedBranches: [] }, "abc1234", { dispatches }, at), "feat/x");
  assert.ok(probes.length > 0 && probes.length <= 10, `${probes.length} probes`);
  assert.equal(new Set(probes).size, probes.length, "no worktree is probed twice");
  probes.length = 0;
  assert.equal(branchOf({ root: "/r", protectedBranches: [] }, "abc1234", { worktree: "/own", dispatches }, at), "feat/x");
  assert.deepEqual(probes, ["/own"], "a known worktree needs one probe");
});

/** A second repository with a linked worktree on feat/9-o. `on` turns its checks on. */
function otherRepo(ws, on) {
  const base = path.dirname(ws.on);
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
  return { other, linked, head: git(linked, "rev-parse", "HEAD"), ledger: path.join(other, ".git", "qc", "ledger.jsonl") };
}

test("the cwd is in one repository with the checks on, and the work is in another with them on", (t) => {
  const ws = workspace(t);
  const b = otherRepo(ws, true);
  const named = namesWorktree(ws, "rb", b.linked);
  const message = `VERDICT: APPROVED ${b.head.slice(0, 8)}\nRED-CHECKED: the test failed before the fix`;
  assert.equal(decide({ ...handback(ws.on, REVIEWER, message), ...named }, ws.tmp), null);
  decide({ ...handback(ws.on, REVIEWER, message, "PostToolUse"), ...named }, ws.tmp);
  assert.equal(decide(stop(ws.on, REVIEWER, "Sent.", named), ws.tmp), null);
  const records = readLedger(b.ledger);
  assert.deepEqual(records.map((record) => record.type), ["stop", "verdict"]);
  assert.deepEqual([records[1].sha, records[1].branch, records[0].worktree], [b.head, "feat/9-o", b.linked]);
  assert.equal(existsSync(ws.ledger), false, "the cwd repository's ledger stays untouched");
  const bad = { ...handback(ws.on, REVIEWER, "VERDICT: APPROVED deadbee\nRED-CHECKED: x"), ...named };
  assert.match(denied(decide(bad, ws.tmp)) ?? "", /deadbee names no commit/);
});

test("the cwd is in a repository with the checks on, and the work is in one with no swarm workflow", (t) => {
  const ws = workspace(t);
  const b = otherRepo(ws, false);
  const named = namesWorktree(ws, "rb", b.linked);
  const message = `VERDICT: APPROVED ${b.head.slice(0, 8)}\nRED-CHECKED: x`;
  const pre = decide({ ...handback(ws.on, REVIEWER, message), ...named }, ws.tmp);
  assert.equal(pre.hookSpecificOutput.permissionDecision, undefined);
  assert.match(pre.hookSpecificOutput.additionalContext, /no swarm workflow/);
  const output = decide(stop(ws.on, REVIEWER, "Sent.", named), ws.tmp);
  assert.equal(output.decision, undefined);
  assert.match(output.systemMessage, /no swarm workflow/);
  const bare = decide(stop(ws.on, IMPLEMENTER, "DONE", namesWorktree(ws, "ib", b.linked)), ws.tmp);
  assert.equal(bare.decision, undefined, "an implementer report is not judged in a repository with no workflow");
  assert.equal(existsSync(ws.ledger), false);
  assert.equal(existsSync(b.ledger), false);
});

test("a stop whose prompt ends its Worktree line with a parenthetical binds that worktree", (t) => {
  const ws = workspace(t);
  const { head, linked } = linkedTask(ws, t);
  const spelled = `${linked.replaceAll(String.fromCharCode(92), "/")} (branch feat/2-y)`;
  assert.equal(decide(stop(ws.on, IMPLEMENTER, REPORT, namesWorktree(ws, "paren", spelled)), ws.tmp), null);
  const [record] = stopsOf(ws);
  assert.deepEqual([record.worktree, record.branch, record.head], [linked, "feat/2-y", head]);
});

test("an implementer that edits qc.config.json in its worktree is still judged", (t) => {
  const ws = workspace(t);
  const { linked } = linkedTask(ws, t);
  writeFileSync(path.join(linked, "qc.config.json"), JSON.stringify({ swarm: { toolCallBudget: 50 } }));
  const output = decide(stop(ws.on, IMPLEMENTER, "DONE", namesWorktree(ws, "cfg", linked)), ws.tmp);
  assert.equal(output.decision, "block");
});

const NOTE = [
  "# Hand-off: Task 3",
  "Brief: C:/scratch/briefs/task-3.md",
  "Worktree: C:/work/kit-85",
  "Branch: feat/85-context",
  "Head: 1a2b3c4",
  "",
  "## Done",
  "- 1a2b3c4 the reader",
  "",
  "## Left",
  "1. wire the guard",
  "",
  "## Next step",
  "node --test packages/qc-harness/src/cli/budget-guard.test.mjs",
].join("\n");

test("an implementer that hands off reports a checked note in place of the RED and GREEN lines", (t) => {
  const ws = workspace(t);
  const note = path.join(ws.tmp, "handoffs", "t3-1.md");
  mkdirSync(path.dirname(note), { recursive: true });
  const missing = decide(handback(ws.on, "architecture:sdd-implementer", `DONE_WITH_CONCERNS\nHANDOFF: ${note}`), ws.tmp);
  assert.match(denied(missing) ?? "", /a hand-off note at .*t3-1\.md that exists and reads \(ENOENT\)/);
  writeFileSync(note, NOTE.replace("Head: 1a2b3c4\n", ""));
  assert.match(denied(decide(handback(ws.on, "architecture:sdd-implementer", `DONE\nHANDOFF: ${note}`), ws.tmp)) ?? "", /a line `Head: <value>` in the hand-off note/);
  writeFileSync(note, NOTE);
  assert.equal(decide(handback(ws.on, "architecture:sdd-implementer", `DONE\nHANDOFF: ${note}`), ws.tmp), null);
  const stopped = decide(stop(ws.on, "sdd-implementer", `DONE\nHANDOFF: ${note}`), ws.tmp);
  assert.equal(stopped?.decision, undefined);
  const [record] = readLedger(ws.ledger);
  assert.equal(record.handoff, note);
});

test("the implementer definition names the HANDOFF line and the resume from a note", () => {
  const body = readFileSync(path.join(AGENTS, "sdd-implementer.md"), "utf8");
  assert.match(body, /`HANDOFF: <note path>`/);
  assert.match(body, /git log --oneline <Head>\.\.HEAD/);
});
