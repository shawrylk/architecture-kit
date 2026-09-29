import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { appendRecord, readLedger } from "./ledger.mjs";
import { decide, namedIssues } from "./merge-guard.mjs";

const HOOK = fileURLToPath(new URL("./merge-guard.mjs", import.meta.url));
const SHA = "0123456789abcdef0123456789abcdef01234567";

/** Checkouts with the checks on (merge kind branch, and task), one with them off, each with a git dir. */
function workspace(t) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-merge-guard-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const make = (name, config) => {
    const dir = path.join(base, name);
    execFileSync("git", ["init", "-q", dir], { stdio: "pipe" });
    writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify(config));
    return dir;
  };
  const on = make("on", { swarm: { dispatch: {} } });
  const task = make("task", { swarm: { dispatch: {}, review: { merge: "task" } } });
  const off = make("off", { swarm: {} });
  return { on, task, off, ledgerOf: (dir) => path.join(dir, ".git", "qc", "ledger.jsonl") };
}

const shell = (cwd, command, hook_event_name = "PreToolUse", tool_name = "Bash") => ({
  session_id: "s",
  cwd,
  hook_event_name,
  tool_name,
  tool_input: { command },
});
const denied = (output) => output?.hookSpecificOutput?.permissionDecisionReason ?? null;
const verdict = (kind, value, sha = SHA) => ({ type: "verdict", kind, verdict: value, sha, branch: "feat/62-x" });

/** A gh stand-in that logs each call and answers with `answer`. */
function fakeGh(answer) {
  const calls = [];
  return { calls, gh: (args, options) => (calls.push({ args, options }), typeof answer === "function" ? answer(args) : answer) };
}

const MERGED = JSON.stringify({
  number: 60,
  url: "https://github.com/o/r/pull/60",
  state: "MERGED",
  mergedAt: "2026-09-29T04:35:17Z",
  baseRefName: "main",
  headRefName: "feat/62-x",
  body: "Closes #59\nRefs #12, see #60 and o/r#13",
  closingIssuesReferences: [
    { number: 59, repository: { name: "r", owner: { login: "o" } } },
    { number: 3, repository: { name: "other", owner: { login: "o" } } },
  ],
});

test("with swarm.dispatch off, a merge is neither judged nor recorded", (t) => {
  const ws = workspace(t);
  const { gh, calls } = fakeGh(MERGED);
  assert.equal(decide(shell(ws.off, "gh pr merge 60"), { gh }), null);
  assert.equal(decide(shell(ws.off, "gh pr merge 60", "PostToolUse"), { gh }), null);
  assert.equal(decide(shell(ws.off, "gh api -X PUT repos/o/r/pulls/60/merge"), { gh }), null);
  assert.equal(calls.length, 0);
});

test("a merge without --match-head-commit is refused", (t) => {
  const ws = workspace(t);
  assert.match(denied(decide(shell(ws.on, "gh pr merge 60 --squash"))) ?? "", /--match-head-commit <sha>/);
});

test("a merge passes only on an APPROVED review of the configured kind for its sha", (t) => {
  const ws = workspace(t);
  const command = `gh pr merge 60 --squash --match-head-commit ${SHA.slice(0, 7)}`;
  assert.match(denied(decide(shell(ws.on, command))) ?? "", /no APPROVED branch review/);
  appendRecord(ws.ledgerOf(ws.on), verdict("task", "APPROVED"));
  assert.match(denied(decide(shell(ws.on, command))) ?? "", /no APPROVED branch review/);
  appendRecord(ws.ledgerOf(ws.task), verdict("task", "APPROVED"));
  assert.equal(decide(shell(ws.task, command)), null);
  appendRecord(ws.ledgerOf(ws.on), verdict("branch", "APPROVED"));
  assert.equal(decide(shell(ws.on, command)), null);
  assert.equal(decide(shell(ws.on, command, "PreToolUse", "PowerShell")), null);
  appendRecord(ws.ledgerOf(ws.on), verdict("branch", "CHANGES_REQUIRED"));
  assert.match(denied(decide(shell(ws.on, command))) ?? "", /the latest is CHANGES_REQUIRED/);
});

test("a short sha in upper case matches the full sha the review approved", (t) => {
  const ws = workspace(t);
  appendRecord(ws.ledgerOf(ws.on), verdict("branch", "APPROVED", SHA.toUpperCase()));
  assert.equal(decide(shell(ws.on, `gh pr merge 60 --match-head-commit ${SHA.slice(0, 7).toUpperCase()}`)), null);
});

test("--auto gets the same review check as an immediate merge", (t) => {
  const ws = workspace(t);
  const auto = `gh pr merge 60 --auto --squash --match-head-commit ${SHA}`;
  assert.match(denied(decide(shell(ws.on, "gh pr merge 60 --auto --squash"))) ?? "", /--match-head-commit <sha>/);
  assert.match(denied(decide(shell(ws.on, auto))) ?? "", /no APPROVED branch review/);
  appendRecord(ws.ledgerOf(ws.on), verdict("branch", "APPROVED"));
  assert.equal(decide(shell(ws.on, auto)), null);
});

test("a gh api call to a PR's merge endpoint is refused outright, even after an approval", (t) => {
  const ws = workspace(t);
  appendRecord(ws.ledgerOf(ws.on), verdict("branch", "APPROVED"));
  for (const [command, tool] of [
    [`gh api -X PUT repos/o/r/pulls/60/merge -f sha=${SHA}`, "Bash"],
    [`bash -c "gh api --method PUT /repos/o/r/pulls/60/merge"`, "Bash"],
    ["gh api repos/o/r/pulls/60/merge -X PUT", "PowerShell"],
  ]) {
    assert.match(denied(decide(shell(ws.on, command, "PreToolUse", tool))) ?? "", /gh pr merge <n> --match-head-commit <sha>/, command);
  }
  assert.equal(decide(shell(ws.on, "gh api repos/o/r/pulls/60/comments")), null);
});

test("a merge inside a nested shell is judged too", (t) => {
  const ws = workspace(t);
  assert.match(denied(decide(shell(ws.on, `bash -c "gh pr merge 60 --match-head-commit ${SHA}"`))) ?? "", /no APPROVED/);
});

test("after the merge, the record keeps the PR, its head sha, its base, and each issue it names", (t) => {
  const ws = workspace(t);
  const { gh, calls } = fakeGh(MERGED);
  const command = `GH_CONFIG_DIR=~/.config/gh-personal gh pr merge 60 -R o/r --squash --match-head-commit ${SHA}`;
  assert.equal(decide({ ...shell(ws.on, command, "PostToolUse"), session_id: "s-merge" }, { gh }), null);
  assert.deepEqual(calls[0].args, [
    "pr", "view", "60", "-R", "o/r", "--json", "number,url,state,mergedAt,baseRefName,headRefName,body,closingIssuesReferences",
  ]);
  assert.deepEqual(calls[0].options.env, { GH_CONFIG_DIR: "~/.config/gh-personal" });
  const [record] = readLedger(ws.ledgerOf(ws.on));
  assert.deepEqual(
    { type: record.type, session: record.session, pr: record.pr, repo: record.repo, sha: record.sha, branch: record.branch, base: record.base, mergedAt: record.mergedAt, ghEnv: record.ghEnv },
    { type: "merge", session: "s-merge", pr: 60, repo: "o/r", sha: SHA, branch: "feat/62-x", base: "main", mergedAt: "2026-09-29T04:35:17Z", ghEnv: { GH_CONFIG_DIR: "~/.config/gh-personal" } },
  );
  assert.deepEqual(record.issues, [
    { repo: "o/r", number: 59 },
    { repo: "o/other", number: 3 },
    { repo: "o/r", number: 12 },
  ]);
});

test("a merge still pending, a failed read, or a second merge of one PR adds no record", (t) => {
  const ws = workspace(t);
  const command = `gh pr merge 60 --auto --match-head-commit ${SHA}`;
  decide(shell(ws.on, command, "PostToolUse"), { gh: fakeGh(JSON.stringify({ ...JSON.parse(MERGED), state: "OPEN" })).gh });
  assert.equal(existsSync(ws.ledgerOf(ws.on)), false);
  assert.match(decide(shell(ws.on, command, "PostToolUse"), { gh: fakeGh(null).gh })?.systemMessage ?? "", /does not record it/);
  assert.equal(decide(shell(ws.on, command, "PostToolUseFailure"), { gh: fakeGh(null).gh }), null);
  decide(shell(ws.on, command, "PostToolUse"), { gh: fakeGh(MERGED).gh });
  decide(shell(ws.on, command, "PostToolUseFailure"), { gh: fakeGh(MERGED).gh });
  assert.equal(readLedger(ws.ledgerOf(ws.on)).length, 1);
});

test("a command with no gh call never runs gh", (t) => {
  const ws = workspace(t);
  const { gh, calls } = fakeGh(MERGED);
  assert.equal(decide(shell(ws.on, "git merge feat/x", "PostToolUse"), { gh }), null);
  assert.equal(calls.length, 0);
});

test("namedIssues drops the PR's own number and each repeat", () => {
  const pr = { number: 7, body: "Fixes #7, #8 and #8. See https://x/#9 and a#10", closingIssuesReferences: [{ number: 8, repository: { name: "r", owner: { login: "o" } } }] };
  assert.deepEqual(namedIssues(pr, "o/r"), [{ repo: "o/r", number: 8 }]);
});

test("the hook process prints the deny", (t) => {
  const ws = workspace(t);
  const result = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(shell(ws.on, "gh pr merge 60")), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
});
