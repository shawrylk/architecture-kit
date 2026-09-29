import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { appendRecord, readLedger } from "./ledger.mjs";
import { decide, verdictOf } from "./report-stop.mjs";
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
const stop = (cwd, agentType, last) => ({
  session_id: "s",
  cwd,
  hook_event_name: "SubagentStop",
  agent_id: "agent-1",
  agent_type: agentType,
  last_assistant_message: last,
  stop_hook_active: false,
});
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
  assert.match(
    denied(decide(handback(ws.on, "architecture:sdd-branch-reviewer", "VERDICT: APPROVED deadbee"), ws.tmp)) ?? "",
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
  assert.equal(decide(stop(ws.on, "sdd-implementer", "DONE\nRED: node --test x: 1 fail\nGREEN: node --test x: 1 pass"), ws.tmp), null);
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

test("an implementer stop records the full head and the branch of its dispatch's worktree", (t) => {
  const ws = workspace(t);
  const { head } = linkedTask(ws, t);
  assert.equal(decide(stop(ws.on, "architecture:sdd-implementer", REPORT), ws.tmp), null);
  const record = readLedger(ws.ledger).find((entry) => entry.type === "stop");
  assert.equal(record.head, head);
  assert.equal(record.branch, "feat/2-y");
});

test("an implementer stop with no dispatch on record writes no head and no branch", (t) => {
  const ws = workspace(t);
  assert.equal(decide(stop(ws.on, "architecture:sdd-implementer", REPORT), ws.tmp), null);
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
