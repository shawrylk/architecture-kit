import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decide } from "./dispatch-guard.mjs";
import { appendRecord, readLedger } from "./ledger.mjs";
import { judgeTask, recordDispatch } from "./task-gate.mjs";

// The guard runs under Codex, whatever runtime runs the test.
process.env.QC_RUNTIME = "codex";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const BRANCH_REVIEWER = "architecture:sdd-branch-reviewer";
const TASK_REVIEWER = "architecture:sdd-reviewer";
const IMPLEMENTER = "architecture:sdd-implementer";
const green = () => ({ reason: null, unknown: null });

/** A checkout with an origin that holds main, and a linked worktree on feat/1-x that starts at main. */
function workspace(t, config = { swarm: { dispatch: {} } }) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-review-gate-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const main = path.join(base, "main");
  const origin = path.join(base, "origin.git");
  git(base, "init", "-q", "-b", "main", main);
  git(base, "init", "-q", "--bare", origin);
  for (const [key, value] of [["user.name", "qc"], ["user.email", "qc@example.com"], ["commit.gpgsign", "false"]]) {
    git(main, "config", key, value);
  }
  writeFileSync(path.join(main, "a.txt"), "a\n");
  writeFileSync(path.join(main, "qc.config.json"), JSON.stringify(config));
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  git(main, "remote", "add", "origin", origin);
  git(main, "push", "-q", "origin", "main");
  git(main, "fetch", "-q", "origin");
  const linked = path.join(base, "linked");
  git(main, "worktree", "add", "-q", "-b", "feat/1-x", linked);
  const tmp = path.join(base, "tmp");
  mkdirSync(tmp);
  return { base, main, origin, linked, tmp, ledger: path.join(main, ".git", "qc", "ledger.jsonl") };
}

function advanceMain(ws, name) {
  writeFileSync(path.join(ws.main, name), `${name}\n`);
  git(ws.main, "add", ".");
  git(ws.main, "commit", "-q", "-m", name);
  git(ws.main, "push", "-q", "origin", "main");
  return git(ws.main, "rev-parse", "HEAD");
}

const call = (ws, type, prompt) => ({
  session_id: "s",
  cwd: ws.main,
  hook_event_name: "PreToolUse",
  tool_name: "Agent",
  tool_use_id: "toolu_1",
  tool_input: { subagent_type: type, description: "Review", prompt },
});
const reviewPrompt = (ws, more = "") => `Review the branch.\nWorktree: ${ws.linked}\n${more}`;
const judge = (ws, type, prompt, deps = { ciState: green }) => judgeTask(call(ws, type, prompt), ws.tmp, deps);
const branchVerdict = (ws, sha) => appendRecord(ws.ledger, { type: "verdict", kind: "branch", verdict: "APPROVED", sha, branch: "feat/1-x" });

test("a reviewer whose head holds the tip of the base, with green CI, passes with no note", (t) => {
  const ws = workspace(t);
  const task = judge(ws, BRANCH_REVIEWER, reviewPrompt(ws));
  assert.equal(task.refusal, null);
  assert.equal(task.note, null);
  recordDispatch(task);
  const [record] = readLedger(ws.ledger);
  assert.equal(record.branch, "feat/1-x");
  assert.equal(record.head, git(ws.linked, "rev-parse", "HEAD"));
});

test("a reviewer on a head that lacks the pushed tip of the base is refused until the base is merged", (t) => {
  const ws = workspace(t);
  advanceMain(ws, "b.txt");
  for (const type of [BRANCH_REVIEWER, TASK_REVIEWER]) {
    assert.match(judge(ws, type, reviewPrompt(ws)).refusal ?? "", /merge origin\/main into the branch first/, type);
  }
  git(ws.main, "fetch", "-q", "origin");
  git(ws.linked, "merge", "-q", "--no-edit", "origin/main");
  assert.equal(judge(ws, BRANCH_REVIEWER, reviewPrompt(ws)).refusal, null);
});

test("a tip that origin holds and this checkout lacks is refused with a fetch", (t) => {
  const ws = workspace(t);
  const other = path.join(ws.base, "other");
  git(ws.base, "clone", "-q", "-b", "main", ws.origin, other);
  for (const [key, value] of [["user.name", "qc"], ["user.email", "qc@example.com"], ["commit.gpgsign", "false"]]) {
    git(other, "config", key, value);
  }
  writeFileSync(path.join(other, "c.txt"), "c\n");
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", "c");
  git(other, "push", "-q", "origin", "main");
  assert.match(judge(ws, BRANCH_REVIEWER, reviewPrompt(ws)).refusal ?? "", /git fetch/);
});

test("with no origin the base check falls back to the local ref, and passes with a note when that is missing", (t) => {
  const ws = workspace(t);
  git(ws.main, "remote", "remove", "origin");
  const task = judge(ws, TASK_REVIEWER, reviewPrompt(ws));
  assert.equal(task.refusal, null);
  assert.match(task.note ?? "", /origin\/main/);
});

test("red CI on the head refuses both reviewer kinds, and unknown CI passes with a note", (t) => {
  const ws = workspace(t);
  const red = { ciState: () => ({ reason: "CI on 1234567: build ended failure", unknown: null }) };
  for (const type of [BRANCH_REVIEWER, TASK_REVIEWER]) {
    assert.match(judge(ws, type, reviewPrompt(ws), red).refusal ?? "", /build ended failure/, type);
  }
  const unknown = judge(ws, BRANCH_REVIEWER, reviewPrompt(ws), { ciState: () => ({ reason: null, unknown: "gh failed or timed out" }) });
  assert.equal(unknown.refusal, null);
  assert.match(unknown.note ?? "", /CI on .* is unknown: gh failed or timed out/);
  assert.equal(recordDispatch(unknown), unknown.note);
  assert.match(judge(ws, TASK_REVIEWER, reviewPrompt(ws), { ci: () => "CI on 1234567: lint is in_progress" }).refusal ?? "", /lint is in_progress/);
});

test("a second branch review is refused without a Reviewed line, and passes with one", (t) => {
  const ws = workspace(t);
  const head = git(ws.linked, "rev-parse", "HEAD");
  assert.equal(judge(ws, BRANCH_REVIEWER, reviewPrompt(ws)).refusal, null);
  branchVerdict(ws, head);
  const refusal = judge(ws, BRANCH_REVIEWER, reviewPrompt(ws)).refusal ?? "";
  assert.match(refusal, /Reviewed: /);
  assert.match(refusal, new RegExp(head.slice(0, 7)));
  assert.equal(judge(ws, BRANCH_REVIEWER, reviewPrompt(ws, `Reviewed: ${head.slice(0, 7)}`)).refusal, null);
  assert.equal(judge(ws, TASK_REVIEWER, reviewPrompt(ws)).refusal, null);
});

test("each review check is a swarm.review key, and a repository switches it off", (t) => {
  const off = { swarm: { dispatch: {}, review: { oneBranchReview: false, requireGreen: false, requireBase: false } } };
  const ws = workspace(t, off);
  advanceMain(ws, "b.txt");
  branchVerdict(ws, git(ws.linked, "rev-parse", "HEAD"));
  const red = { ciState: () => assert.fail("CI asked") };
  assert.equal(judge(ws, BRANCH_REVIEWER, reviewPrompt(ws), red).refusal, null);
});

const withBrief = (text) => `Brief: ${text}\n## Product decisions\nNone.`;
const implement = (ws, prompt) => judge(ws, IMPLEMENTER, `${prompt}\nWorktree: ${ws.linked}`);

test("an implementer brief with no Product decisions heading is refused, and the heading passes it", (t) => {
  const ws = workspace(t);
  assert.match(implement(ws, "Read the brief.").refusal ?? "", /## Product decisions/);
  assert.equal(implement(ws, withBrief("plans/b.md")).refusal, null);
  assert.equal(judge(ws, TASK_REVIEWER, reviewPrompt(ws)).refusal, null);
});

test("the brief file decides: its heading passes the dispatch, and its absence refuses it", (t) => {
  const ws = workspace(t);
  const good = path.join(ws.base, "good-brief.md");
  const bad = path.join(ws.base, "bad-brief.md");
  writeFileSync(good, "# Brief\n\n## Product decisions\n\nNone.\n");
  writeFileSync(bad, "# Brief\n\nDo it.\n");
  assert.equal(implement(ws, `Read the brief at ${good}.`).refusal, null);
  const refusal = implement(ws, `Read the brief at ${bad}.`).refusal ?? "";
  assert.match(refusal, /bad-brief\.md/);
  assert.match(refusal, /## Product decisions/);
});

test("a long brief file warns and still passes, and the warning reaches the session", (t) => {
  const ws = workspace(t);
  const brief = path.join(ws.base, "long-brief.md");
  const findings = Array.from({ length: 9 }, (_unused, index) => `${index + 1}. finding ${index}`).join("\n");
  writeFileSync(brief, `## Product decisions\nNone.\n${findings}\n`);
  const task = implement(ws, `Read the brief at ${brief}.`);
  assert.equal(task.refusal, null);
  assert.match(task.note ?? "", /9 numbered findings/);
  const output = decide(call(ws, IMPLEMENTER, `Read the brief at ${brief}.\nWorktree: ${ws.linked}`), ws.tmp, Date.now(), { ciState: green });
  assert.match(output.hookSpecificOutput.additionalContext, /disjoint paths/);
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
});

test("the dispatch guard refuses a reviewer and claims no slot for it", (t) => {
  const ws = workspace(t);
  advanceMain(ws, "b.txt");
  const output = decide(call(ws, BRANCH_REVIEWER, reviewPrompt(ws)), ws.tmp, Date.now(), { ciState: green });
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /^Task gate:/);
});
