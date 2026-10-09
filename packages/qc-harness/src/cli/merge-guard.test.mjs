import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  execFileSync("git", ["remote", "add", "origin", "git@github.com-personal:o/r.git"], { cwd: on, stdio: "pipe" });
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

test("with swarm.dispatch off, a merge is not judged, and the merge is recorded for the worktree check", (t) => {
  const ws = workspace(t);
  const { gh, calls } = fakeGh(MERGED);
  assert.equal(decide(shell(ws.off, "gh pr merge 60"), { gh }), null);
  assert.equal(decide(shell(ws.off, "gh api -X PUT repos/o/r/pulls/60/merge"), { gh }), null);
  assert.equal(calls.length, 0, "a PreToolUse call reads nothing");
  assert.equal(decide(shell(ws.off, "gh pr merge 60", "PostToolUse"), { gh }), null);
  const records = readLedger(ws.ledgerOf(ws.off));
  assert.deepEqual(records.map(({ type, pr, repo, branch }) => ({ type, pr, repo, branch })), [{ type: "merge", pr: 60, repo: "o/r", branch: "feat/62-x" }]);
});

test("with swarm.dispatch off and worktree.enforce false, a merge is neither judged nor recorded", (t) => {
  const ws = workspace(t);
  writeFileSync(path.join(ws.off, "qc.config.json"), JSON.stringify({ swarm: {}, worktree: { enforce: false } }));
  const { gh, calls } = fakeGh(MERGED);
  assert.equal(decide(shell(ws.off, "gh pr merge 60"), { gh }), null);
  assert.equal(decide(shell(ws.off, "gh pr merge 60", "PostToolUse"), { gh }), null);
  assert.equal(calls.length, 0);
  assert.equal(existsSync(ws.ledgerOf(ws.off)), false);
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

test("a failed read, or a second merge of one PR, adds no second record", (t) => {
  const ws = workspace(t);
  const command = `gh pr merge 60 --match-head-commit ${SHA}`;
  decide(shell(ws.on, command, "PostToolUse"), { gh: fakeGh(JSON.stringify({ ...JSON.parse(MERGED), state: "OPEN" })).gh });
  assert.equal(existsSync(ws.ledgerOf(ws.on)), false, "an immediate merge that is not merged leaves no record");
  assert.match(decide(shell(ws.on, command, "PostToolUse"), { gh: fakeGh(null).gh })?.systemMessage ?? "", /does not record it/);
  assert.equal(decide(shell(ws.on, command, "PostToolUseFailure"), { gh: fakeGh(null).gh }), null);
  decide(shell(ws.on, command, "PostToolUse"), { gh: fakeGh(MERGED).gh });
  decide(shell(ws.on, command, "PostToolUseFailure"), { gh: fakeGh(MERGED).gh });
  assert.equal(readLedger(ws.ledgerOf(ws.on)).length, 1);
});

test("an --auto merge still open writes a pending record, once, and a later merge adds the real record", (t) => {
  const ws = workspace(t);
  const command = `gh pr merge 60 --auto --squash --match-head-commit ${SHA}`;
  const open = fakeGh(JSON.stringify({ ...JSON.parse(MERGED), state: "OPEN", mergedAt: null })).gh;
  decide(shell(ws.on, command, "PostToolUse"), { gh: open });
  decide(shell(ws.on, command, "PostToolUse"), { gh: open });
  const [pending, ...rest] = readLedger(ws.ledgerOf(ws.on));
  assert.equal(rest.length, 0);
  assert.deepEqual(
    { type: pending.type, pending: pending.pending, pr: pending.pr, repo: pending.repo, sha: pending.sha, branch: pending.branch, mergedAt: pending.mergedAt },
    { type: "merge", pending: true, pr: 60, repo: "o/r", sha: SHA, branch: "feat/62-x", mergedAt: null },
  );
  assert.deepEqual(pending.issues, [{ repo: "o/r", number: 59 }, { repo: "o/other", number: 3 }, { repo: "o/r", number: 12 }]);
  decide(shell(ws.on, command, "PostToolUse"), { gh: fakeGh(MERGED).gh });
  const merged = readLedger(ws.ledgerOf(ws.on)).filter((record) => !record.pending);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].mergedAt, "2026-09-29T04:35:17Z");
});

test("gh api graphql with a mergePullRequest mutation is refused, and the REST endpoint spellings all match", (t) => {
  const ws = workspace(t);
  appendRecord(ws.ledgerOf(ws.on), verdict("branch", "APPROVED"));
  for (const [command, tool] of [
    ["gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"X\"}) { clientMutationId } }'", "Bash"],
    ['gh api graphql -F query="mutation { mergePullRequest(input: {pullRequestId: 1}) { clientMutationId } }"', "PowerShell"],
    [`bash -c "gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'"`, "Bash"],
    ["gh api -X PUT repos/o/r/pulls/60/merge/", "Bash"],
    ["gh api -X PUT /repos/o/r/pulls/60/merge/?x=1", "Bash"],
    ["gh api -X PUT https://api.github.com/repos/o/r/pulls/60/merge", "Bash"],
    ["gh api -X PUT https://api.github.com/repos/o/r/pulls/60/merge/", "PowerShell"],
    ["gh api https://api.github.com/graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'", "Bash"],
    ["gh api https://ghe.example.com/api/graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'", "PowerShell"],
  ]) {
    assert.match(denied(decide(shell(ws.on, command, "PreToolUse", tool))) ?? "", /gh pr merge <n> --match-head-commit <sha>/, command);
  }
  assert.equal(decide(shell(ws.on, "gh api graphql -f query='query { viewer { login } }'")), null);
  assert.equal(decide(shell(ws.on, "gh api https://api.github.com/repos/o/r/pulls/60/comments")), null);
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

test("a merge that names another repository than the checkout's origin passes with a note and records nothing", (t) => {
  const ws = workspace(t);
  const other = `gh pr merge 64 -R shawrylk/architecture-kit --squash --match-head-commit ${SHA}`;
  const output = decide(shell(ws.on, other));
  assert.equal(denied(output), null);
  assert.match(output.hookSpecificOutput.additionalContext, /shawrylk\/architecture-kit/);
  assert.match(output.hookSpecificOutput.additionalContext, /o\/r/);
  const { gh, calls } = fakeGh(MERGED);
  assert.equal(decide(shell(ws.on, other, "PostToolUse"), { gh }), null);
  assert.equal(calls.length, 0);
  assert.equal(existsSync(ws.ledgerOf(ws.on)), false);
  // The same call with no sha pin still passes for another repository, --repo included.
  assert.equal(denied(decide(shell(ws.on, "gh pr merge 64 --repo=shawrylk/architecture-kit"))), null);
  // The checkout's own repository, in any spelling, is still judged.
  for (const named of ["-R o/r", "--repo O/R", "-R github.com/o/r"]) {
    assert.match(denied(decide(shell(ws.on, `gh pr merge 60 ${named} --match-head-commit ${SHA}`))) ?? "", /no APPROVED branch review/, named);
  }
  // A merge of the own repository next to a merge of another one is still refused.
  assert.match(denied(decide(shell(ws.on, `${other} && gh pr merge 60 -R o/r`))) ?? "", /--match-head-commit <sha>/);
});

test("a checkout with no readable origin judges a merge that names a repository", (t) => {
  const ws = workspace(t);
  assert.match(denied(decide(shell(ws.task, `gh pr merge 60 -R o/r --match-head-commit ${SHA}`))) ?? "", /no APPROVED task review/);
});

test("a failed --auto merge of an open PR writes no pending record", (t) => {
  const ws = workspace(t);
  const command = `gh pr merge 60 --auto --squash --match-head-commit ${SHA}`;
  const open = fakeGh(JSON.stringify({ ...JSON.parse(MERGED), state: "OPEN", mergedAt: null })).gh;
  assert.equal(decide(shell(ws.on, command, "PostToolUseFailure"), { gh: open }), null);
  assert.equal(existsSync(ws.ledgerOf(ws.on)), false);
  decide(shell(ws.on, command, "PostToolUse"), { gh: open });
  assert.equal(readLedger(ws.ledgerOf(ws.on)).length, 1, "a call that succeeded still records the pending merge");
});

test("a ledger that cannot be read or written never throws out of the guard", (t) => {
  const ws = workspace(t);
  const ledger = ws.ledgerOf(ws.on);
  mkdirSync(ledger, { recursive: true }); // a directory where the file belongs: read and write both fail
  const command = `gh pr merge 60 --squash --match-head-commit ${SHA}`;
  const after = decide(shell(ws.on, command, "PostToolUse"), { gh: fakeGh(MERGED).gh });
  assert.match(after?.systemMessage ?? "", /ledger/);
  assert.match(denied(decide(shell(ws.on, command))) ?? "", /ledger/);
});

test("namedIssues takes body numbers only from Refs, Closes, Fixes, and Resolves lines", () => {
  const pr = {
    number: 61,
    body: ["Adds the guard, as PR #61 and #40 did.", "Related to #41 and #42.", "  refs #12, #13", "Resolves: #14", "- Fixes #15", "Closes #16 and o/r#17", "Not a Fixes line #18"].join("\r\n"),
  };
  assert.deepEqual(
    namedIssues(pr, "o/r").map((issue) => issue.number),
    [12, 13, 14, 15, 16],
  );
  assert.deepEqual(namedIssues({ number: 1, body: "See #5 and #6" }, "o/r"), []);
});

test("a graphql call with a query file holding the mutation, or a file it cannot read, is refused", (t) => {
  const ws = workspace(t);
  writeFileSync(path.join(ws.on, "merge.graphql"), "mutation { mergePullRequest(input: {}) { clientMutationId } }");
  writeFileSync(path.join(ws.on, "viewer.graphql"), "query { viewer { login } }");
  const refusal = (command) => denied(decide(shell(ws.on, command)));
  assert.match(refusal("gh api https://api.github.com/graphql -F query=@merge.graphql") ?? "", /gh pr merge <n> --match-head-commit <sha>/);
  assert.match(refusal("gh api graphql -F query=@missing.graphql") ?? "", /missing\.graphql/);
  assert.equal(refusal("gh api graphql -F query=@viewer.graphql"), null);
});

test("an --auto merge on a PR reopened after a closed pending record is tracked again", (t) => {
  const ws = workspace(t);
  const command = `gh pr merge 60 --auto --squash --match-head-commit ${SHA}`;
  const open = fakeGh(JSON.stringify({ ...JSON.parse(MERGED), state: "OPEN", mergedAt: null })).gh;
  decide(shell(ws.on, command, "PostToolUse"), { gh: open });
  const [pending] = readLedger(ws.ledgerOf(ws.on));
  appendRecord(ws.ledgerOf(ws.on), { ...pending, pending: undefined, closed: true, mergedAt: null });
  decide(shell(ws.on, command, "PostToolUse"), { gh: open });
  const records = readLedger(ws.ledgerOf(ws.on));
  assert.equal(records.length, 3);
  assert.equal(records[2].pending, true);
  decide(shell(ws.on, command, "PostToolUse"), { gh: open });
  assert.equal(readLedger(ws.ledgerOf(ws.on)).length, 3, "and a repeat adds no fourth record");
});

test("a merge names another repository through a PR URL, GH_REPO, or an attached -R, and passes with a note", (t) => {
  const ws = workspace(t);
  for (const command of [
    `gh pr merge https://github.com/shawrylk/architecture-kit/pull/64 --match-head-commit ${SHA}`,
    `GH_REPO=shawrylk/architecture-kit gh pr merge 64 --match-head-commit ${SHA}`,
    `gh pr merge 64 -Rshawrylk/architecture-kit --match-head-commit ${SHA}`,
    `gh pr merge 64 -sRshawrylk/architecture-kit --match-head-commit ${SHA}`,
  ]) {
    const output = decide(shell(ws.on, command));
    assert.equal(denied(output), null, command);
    assert.match(output.hookSpecificOutput.additionalContext, /shawrylk\/architecture-kit/, command);
    const { gh, calls } = fakeGh(MERGED);
    assert.equal(decide(shell(ws.on, command, "PostToolUse"), { gh }), null);
    assert.equal(calls.length, 0, command);
  }
  assert.equal(existsSync(ws.ledgerOf(ws.on)), false);
  // The checkout's own repository, named the same ways, is still judged.
  for (const command of [
    `gh pr merge https://github.com/o/r/pull/60 --match-head-commit ${SHA}`,
    `GH_REPO=o/r gh pr merge 60 --match-head-commit ${SHA}`,
    `gh pr merge 60 -Ro/r --match-head-commit ${SHA}`,
  ]) {
    assert.match(denied(decide(shell(ws.on, command))) ?? "", /no APPROVED branch review/, command);
  }
});

test("a gh api call to a repos/ path whose body file quotes the mutation is allowed", (t) => {
  const ws = workspace(t);
  writeFileSync(path.join(ws.on, "review.md"), "The bypass is the mergePullRequest mutation.");
  assert.equal(decide(shell(ws.on, "gh api repos/o/r/issues/64/comments -F body=@review.md")), null);
  assert.match(denied(decide(shell(ws.on, "gh api graphql -F query=@review.md"))) ?? "", /gh pr merge <n> --match-head-commit <sha>/);
});

test("with swarm.dispatch off, a merge whose command failed after GitHub merged is still recorded", (t) => {
  const ws = workspace(t);
  // `gh pr merge --delete-branch` exits non-zero when a worktree holds the branch, after the merge itself.
  assert.equal(decide(shell(ws.off, "gh pr merge 60 --squash --delete-branch", "PostToolUseFailure"), { gh: fakeGh(MERGED).gh }), null);
  assert.deepEqual(readLedger(ws.ledgerOf(ws.off)).map(({ type, pr }) => ({ type, pr })), [{ type: "merge", pr: 60 }]);
});

/** A checkout with the checks on, `origin/main` at its first commit, and a small fix on `feat/1-x`. */
function laneRepo(t, config = { swarm: { dispatch: {} } }) {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-merge-lane-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  for (const [key, value] of [["user.name", "qc"], ["user.email", "qc@example.com"], ["commit.gpgsign", "false"]]) git("config", key, value);
  writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify(config));
  writeFileSync(path.join(dir, "a.ts"), "one\ntwo\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("switch", "-q", "-c", "feat/1-x");
  writeFileSync(path.join(dir, "a.ts"), "one\n2\n");
  git("commit", "-q", "-am", "fix");
  return { dir, head: git("rev-parse", "HEAD"), ledger: path.join(dir, ".git", "qc", "ledger.jsonl") };
}

test("a small head with no review merges through the direct lane, with a note", (t) => {
  const { dir, head } = laneRepo(t);
  const { gh, calls } = fakeGh(JSON.stringify({ baseRefName: "main" }));
  const output = decide(shell(dir, `gh pr merge 7 --squash --match-head-commit ${head}`), { gh });
  assert.equal(denied(output), null);
  assert.deepEqual(calls[0].args, ["pr", "view", "7", "--json", "baseRefName"]);
  assert.match(output?.hookSpecificOutput?.additionalContext ?? "", /merges through the direct lane, with 2 of 20 lines in 1 of 2 files and no review/);
  assert.match(denied(decide(shell(dir, "gh pr merge 7 --squash"))) ?? "", /--match-head-commit <sha>/);
});

test("a review that asked for changes keeps a small head out of the direct lane", (t) => {
  const { dir, head, ledger } = laneRepo(t);
  appendRecord(ledger, verdict("task", "CHANGES_REQUIRED", head));
  const reason = denied(decide(shell(dir, `gh pr merge 7 --squash --match-head-commit ${head}`))) ?? "";
  assert.match(reason, /no APPROVED branch review/);
  assert.match(reason, /The direct lane of swarm\.direct does not apply: the latest review on the branch, of .*, is CHANGES_REQUIRED/);
});

test("with swarm.direct false, a small head needs its review as before", (t) => {
  const { dir, head } = laneRepo(t, { swarm: { dispatch: {}, direct: false } });
  const reason = denied(decide(shell(dir, `gh pr merge 7 --squash --match-head-commit ${head}`))) ?? "";
  assert.match(reason, /no APPROVED branch review/);
  assert.doesNotMatch(reason, /direct lane/);
});

test("a wrong swarm.direct closes the lane and keeps the merge guard on", (t) => {
  const { dir, head } = laneRepo(t, { swarm: { dispatch: {}, direct: { maxLines: 0 } } });
  const reason = denied(decide(shell(dir, `gh pr merge 7 --squash --match-head-commit ${head}`))) ?? "";
  assert.match(reason, /no APPROVED branch review/);
  assert.match(reason, /does not apply: swarm.direct.maxLines/);
});

test("a PR into another base, or a PR whose base gh cannot read, stays out of the direct lane", (t) => {
  const { dir, head } = laneRepo(t);
  const merge = shell(dir, `gh pr merge 7 --squash --match-head-commit ${head}`);
  assert.match(denied(decide(merge, { gh: fakeGh(JSON.stringify({ baseRefName: "release/2.0" })).gh })) ?? "", /the PR merges into release\/2\.0, and the lane measures against origin\/main/);
  assert.match(denied(decide(merge, { gh: fakeGh(null).gh })) ?? "", /gh cannot read the base branch of the PR/);
});
