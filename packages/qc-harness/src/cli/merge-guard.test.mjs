import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { appendRecord, readLedger } from "./ledger.mjs";
import { decide as decideMerge, mergeVerdict, namedIssues } from "./merge-guard.mjs";

const HOOK = fileURLToPath(new URL("./merge-guard.mjs", import.meta.url));
const SHA = "0123456789abcdef0123456789abcdef01234567";
const bases = new Map();
const decide = (call, options = {}) => decideMerge(call, { gh: fakeGh(prView(bases.get(call.cwd))).gh, ...options });

/** Checkouts with the checks on (merge kind branch, and task), one with them off, each with a git dir. */
function workspace(t) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-merge-guard-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const make = (name, config) => {
    const dir = path.join(base, name);
    execFileSync("git", ["init", "-q", dir], { stdio: "pipe" });
    writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify(config));
    for (const args of [["config", "user.name", "qc"], ["config", "user.email", "qc@example.com"], ["config", "commit.gpgsign", "false"], ["add", "."], ["commit", "-q", "-m", "init"]]) {
      execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    }
    bases.set(dir, execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim());
    return dir;
  };
  const on = make("on", { swarm: { dispatch: {} } });
  execFileSync("git", ["remote", "add", "origin", "git@github.com-personal:o/r.git"], { cwd: on, stdio: "pipe" });
  const task = make("task", { swarm: { dispatch: {}, review: { merge: "task" } } });
  const off = make("off", { swarm: {} });
  const promo = make("promo", { swarm: { dispatch: {}, review: { promotion: { integration: "dev", release: "main" } } } });
  return { on, task, off, promo, ledgerOf: (dir) => path.join(dir, ".git", "qc", "ledger.jsonl") };
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
  assert.equal(decide(shell(ws.off, "gh pr merge 60")), null);
  assert.equal(decide(shell(ws.off, "gh api -X PUT repos/o/r/pulls/60/merge")), null);
  assert.equal(decide(shell(ws.off, "gh pr merge 60", "PostToolUse"), { gh }), null);
  assert.equal(calls.length, 1);
  const records = readLedger(ws.ledgerOf(ws.off));
  assert.deepEqual(records.map(({ type, pr, repo, branch }) => ({ type, pr, repo, branch })), [{ type: "merge", pr: 60, repo: "o/r", branch: "feat/62-x" }]);
});

test("with swarm.dispatch off and worktree.enforce false, a merge is neither judged nor recorded", (t) => {
  const ws = workspace(t);
  writeFileSync(path.join(ws.off, "qc.config.json"), JSON.stringify({ swarm: {}, worktree: { enforce: false } }));
  const { gh, calls } = fakeGh(MERGED);
  assert.equal(decide(shell(ws.off, "gh pr merge 60")), null);
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

test("an API merge reads the endpoint PR's base and settings before enforcing dispatch", (t) => {
  const { dir, base } = laneRepo(t, { swarm: {} });
  writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {} } }));
  const { gh, calls } = fakeGh(prView(base));
  const command = "GH_CONFIG_DIR=account gh api --hostname ghe.example.com -X PUT repos/other/project/pulls/23/merge";
  assert.equal(decide(shell(dir, command), { gh }), null);
  assert.deepEqual(calls[0].args, ["pr", "view", "23", "-R", "other/project", "--json", "baseRefName,baseRefOid,headRefName"]);
  assert.deepEqual(calls[0].options.env, { GH_CONFIG_DIR: "account", GH_HOST: "ghe.example.com" });
});

test("an API merge passes when the base has no config and denies an unreadable PR or base", (t) => {
  const { dir, base } = laneRepo(t, { swarm: { dispatch: {} } }, { tracked: false });
  const command = shell(dir, "gh api -X PUT https://api.github.com/repos/o/r/pulls/23/merge");
  const { gh, calls } = fakeGh(prView(base));
  assert.equal(decide(command, { gh }), null);
  assert.deepEqual(calls[0].args.slice(0, 5), ["pr", "view", "23", "-R", "o/r"]);
  assert.equal(calls[0].options.env.GH_HOST, "github.com");
  assert.match(denied(decide(command, { gh: () => null })) ?? "", /gh cannot read the base branch/);
  assert.match(denied(decide(command, { gh: fakeGh(prView("f".repeat(40))).gh })) ?? "", /base commit.*not in this repository/);
});

test("a placeholder REST merge reads its PR base with the inline or current repository", (t) => {
  const { dir, base } = laneRepo(t, { swarm: { dispatch: {} } }, { tracked: false });
  for (const [prefix, repo] of [["", null], ["GH_REPO=other/project ", "other/project"]]) {
    const { gh, calls } = fakeGh(prView(base));
    assert.equal(decide(shell(dir, `${prefix}gh api -X PUT repos/{owner}/{repo}/pulls/5/merge`), { gh }), null);
    assert.deepEqual(calls[0].args, ["pr", "view", "5", ...(repo ? ["-R", repo] : []), "--json", "baseRefName,baseRefOid,headRefName"]);
    assert.deepEqual(calls[0].options.env, {});
  }
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-q", "-m", "enable dispatch");
  const enabled = gitIn(dir, "rev-parse", "HEAD");
  const command = shell(dir, "gh api -X PUT repos/{owner}/{repo}/pulls/5/merge");
  assert.match(denied(decide(command, { gh: fakeGh(prView(enabled)).gh })) ?? "", /gh pr merge/);
  const { gh, calls } = fakeGh(prView(base));
  assert.match(denied(decide(shell(dir, "gh api -X PUT repos/{owner}/project/pulls/5/merge"), { gh })) ?? "", /gh pr merge/);
  assert.equal(calls.length, 0);
});

test("every API merge in a command reads its own base policy", (t) => {
  const { dir, base } = laneRepo(t, { swarm: { dispatch: {} } });
  writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify({ swarm: {} }));
  gitIn(dir, "commit", "-q", "-am", "dispatch off");
  const off = gitIn(dir, "rev-parse", "HEAD");
  const gh = fakeGh((args) => prView(args[2] === "23" ? off : base)).gh;
  assert.match(denied(decide(shell(dir, "gh api repos/o/r/pulls/23/merge; gh api repos/o/r/pulls/24/merge"), { gh })) ?? "", /gh pr merge/);
});

test("a GraphQL merge reads its node and base policy within the shared deadline", (t) => {
  const { dir, base } = laneRepo(t, { swarm: { dispatch: {} } }, { tracked: false });
  const command = shell(dir, 'GH_CONFIG_DIR=account GH_REPO=ignored/repo gh api https://ghe.example.com/api/graphql -f query=\'mutation($id: ID!) { mergePullRequest(input: {pullRequestId: $id}) { clientMutationId } }\' -F id=PR_123');
  const node = (oid) => JSON.stringify({ data: { node: { number: 5, baseRefName: "main", baseRefOid: oid, repository: { nameWithOwner: "o/r" } } } });
  const { gh, calls } = fakeGh(node(base));
  assert.equal(decide(command, { gh }), null);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 2), ["api", "graphql"]);
  assert.match(calls[0].args.join(" "), /node\(id:\s*\$id\)\s*\{\s*\.\.\. on PullRequest\s*\{\s*number baseRefName baseRefOid repository\s*\{\s*nameWithOwner/);
  assert.ok(calls[0].args.includes("id=PR_123"));
  assert.deepEqual(calls[0].options.env, { GH_CONFIG_DIR: "account", GH_HOST: "ghe.example.com" });
  assert.ok(calls[0].options.timeoutMs > 0);
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-q", "-m", "enable dispatch");
  const enabled = gitIn(dir, "rev-parse", "HEAD");
  assert.match(denied(decide(command, { gh: fakeGh(node(enabled)).gh })) ?? "", /gh pr merge/);
  for (const answer of [null, "invalid", JSON.stringify({ data: { node: { id: "issue" } } }), JSON.stringify({ data: { node: null } }), node("f".repeat(40))]) {
    assert.match(denied(decide(command, { gh: fakeGh(answer).gh })) ?? "", /base policy cannot be read/);
  }
  assert.match(denied(decide(command, { gh: () => { throw new Error("lookup failed"); } })) ?? "", /base policy cannot be read/);
  const missing = fakeGh(node(base));
  assert.match(denied(decide(shell(dir, "gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'"), { gh: missing.gh })) ?? "", /gh pr merge/);
  assert.equal(missing.calls.length, 0);
});

test("a GraphQL endpoint with a fragment and stdin denies with dispatch on", (t) => {
  const { on } = workspace(t);
  for (const tool of ["Bash", "PowerShell"]) {
    assert.match(denied(decide(shell(on, "gh api 'graphql#x' --input -", "PreToolUse", tool))) ?? "", /gh pr merge/);
  }
});

test("a GraphQL endpoint with a fragment keeps its GHE host for the node lookup", (t) => {
  const { dir, base } = laneRepo(t, { swarm: {} });
  const node = JSON.stringify({ data: { node: { number: 5, baseRefName: "main", baseRefOid: base, repository: { nameWithOwner: "o/r" } } } });
  for (const tool of ["Bash", "PowerShell"]) {
    const { gh, calls } = fakeGh(node);
    const command = `gh api 'https://ghe.example.com/api/graphql#x' -f query='mutation { mergePullRequest(input: {pullRequestId: "PR_ON"}) { clientMutationId } }'`;
    assert.equal(decide(shell(dir, command, "PreToolUse", tool), { gh }), null);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes("id=PR_ON"));
    assert.equal(calls[0].options.env.GH_HOST, "ghe.example.com");
  }
});

test("a REST endpoint with a fragment reads the PR base policy", (t) => {
  const { dir, base } = laneRepo(t, { swarm: { dispatch: {} } }, { tracked: false });
  for (const tool of ["Bash", "PowerShell"]) {
    const { gh, calls } = fakeGh(prView(base));
    assert.equal(decide(shell(dir, "gh api 'repos/o/r/pulls/1/merge#x' -X PUT", "PreToolUse", tool), { gh }), null);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["pr", "view", "1", "-R", "o/r", "--json", "baseRefName,baseRefOid,headRefName"]);
  }
});

test("the merge guard documents the unconditional GraphQL input-field denial", () => {
  const reference = readFileSync(new URL("../../../../docs/reference.md", import.meta.url), "utf8");
  const header = readFileSync(HOOK, "utf8").split("import ")[0].replace(/^\/\/ ?/gm, "").replace(/\s+/g, " ");
  for (const text of [reference, header]) {
    assert.ok(text.includes("Any `gh api graphql` call that mixes `--input` with a field denies, whether it reads or writes."));
    assert.ok(text.includes("This applies in every checkout, with `swarm.dispatch` on or off."));
  }
});

test("a GraphQL node lookup uses the endpoint host after a decoy header", (t) => {
  const { dir, base } = laneRepo(t, { swarm: {} });
  const node = JSON.stringify({ data: { node: { number: 5, baseRefName: "main", baseRefOid: base, repository: { nameWithOwner: "o/r" } } } });
  for (const tool of ["Bash", "PowerShell"]) {
    const { gh, calls } = fakeGh(node);
    const command = shell(dir, 'gh api -H https://github.com/graphql https://ghe.example.com/api/graphql -f query=\'mutation { mergePullRequest(input: {pullRequestId: "PR_ON"}) { clientMutationId } }\'', "PreToolUse", tool);
    assert.equal(decide(command, { gh }), null);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes("id=PR_ON"));
    assert.equal(calls[0].options.env.GH_HOST, "ghe.example.com");
  }
});

test("GraphQL input mixed with fields denies before a decoy node lookup", (t) => {
  const { dir, base } = laneRepo(t, { swarm: {} });
  const query = 'mutation($id: ID!) { mergePullRequest(input: {pullRequestId: $id}) { clientMutationId } }';
  writeFileSync(path.join(dir, "body.json"), JSON.stringify({ query, variables: { id: "PR_ON" } }));
  const node = JSON.stringify({ data: { node: { number: 5, baseRefName: "main", baseRefOid: base, repository: { nameWithOwner: "o/r" } } } });
  const fields = ["-f id=PR_OFF", "-F id=PR_OFF", "--field=id=PR_OFF", "--raw-field id=PR_OFF", "-fid=PR_OFF", "-iFid=PR_OFF",
    `-f query='mutation { mergePullRequest(input: {pullRequestId: "PR_OFF"}) { clientMutationId } }'`];
  for (const field of fields) {
    for (const tool of ["Bash", "PowerShell"]) {
      const { gh, calls } = fakeGh(node);
      const command = shell(dir, `gh api graphql --input body.json ${field}`, "PreToolUse", tool);
      assert.match(denied(decide(command, { gh })) ?? "", /--input.*(?:-f|-F|--field|--raw-field)/, field);
      assert.equal(calls.length, 0, field);
    }
  }
  writeFileSync(path.join(dir, "body.json"), JSON.stringify({ query: "query { viewer { login } }" }));
  assert.match(denied(decide(shell(dir, "gh api graphql -f id=PR_OFF --input=body.json"))) ?? "", /--input.*-f/);
});

test("GraphQL input-field denial covers reads and writes with dispatch on or off", (t) => {
  const { on, off } = workspace(t);
  for (const dir of [on, off]) {
    for (const query of ["query { viewer { login } }", 'mutation { mergePullRequest(input: {pullRequestId: "PR_ON"}) { clientMutationId } }']) {
      writeFileSync(path.join(dir, "body.json"), JSON.stringify({ query }));
      for (const tool of ["Bash", "PowerShell"]) {
        const { gh, calls } = fakeGh(null);
        const command = shell(dir, "gh api graphql --input body.json -f id=PR_OFF", "PreToolUse", tool);
        assert.match(denied(decide(command, { gh })) ?? "", /--input.*-f/);
        assert.equal(calls.length, 0);
      }
    }
  }
});

test("a GraphQL lookup shares the policy deadline and denies an expired read", (t) => {
  const { dir, base } = laneRepo(t, { swarm: {} });
  const start = Date.now();
  const clock = t.mock.method(Date, "now", () => start);
  const { gh, calls } = fakeGh(() => {
    clock.mock.mockImplementation(() => start + 60_000);
    return JSON.stringify({ data: { node: { number: 5, baseRefName: "main", baseRefOid: base, repository: { nameWithOwner: "o/r" } } } });
  });
  const command = shell(dir, 'gh api graphql -f query=\'mutation { mergePullRequest(input: {pullRequestId: "PR_123"}) { clientMutationId } }\'');
  assert.match(denied(decide(command, { gh })) ?? "", /base policy cannot be read/);
  assert.equal(calls.length, 1);
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

/** A checkout with the checks on, `origin/main` at its first commit, and a small fix on `feat/1-x`. `tracked: false` keeps the config out of that commit. */
function laneRepo(t, config = { swarm: { dispatch: {} } }, { tracked = true } = {}) {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-merge-lane-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  for (const [key, value] of [["user.name", "qc"], ["user.email", "qc@example.com"], ["commit.gpgsign", "false"]]) git("config", key, value);
  if (tracked) writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify(config));
  writeFileSync(path.join(dir, "a.ts"), "one\ntwo\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  if (!tracked) writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify(config));
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("switch", "-q", "-c", "feat/1-x");
  writeFileSync(path.join(dir, "a.ts"), "one\n2\n");
  git("commit", "-q", "-am", "fix");
  bases.set(dir, git("rev-parse", "origin/main"));
  return { dir, head: git("rev-parse", "HEAD"), base: git("rev-parse", "origin/main"), ledger: path.join(dir, ".git", "qc", "ledger.jsonl") };
}

/** What `gh pr view --json baseRefName,baseRefOid` answers for a PR into `main` whose base commit is `oid`. */
const prView = (oid, name = "main", head) => JSON.stringify({ baseRefName: name, baseRefOid: oid, headRefName: head });

test("a promotion PR needs its scoped promotion approval", (t) => {
  const ws = workspace(t);
  const command = shell(ws.promo, `gh pr merge 7 --match-head-commit ${SHA}`);
  const { gh, calls } = fakeGh(prView(bases.get(ws.promo), "main", "dev"));
  assert.match(denied(decide(command, { gh })) ?? "", /qc review promotion 7/);
  assert.equal(calls[0].args.at(-1), "baseRefName,baseRefOid,headRefName");
  appendRecord(ws.ledgerOf(ws.promo), { ...verdict("branch", "APPROVED"), scope: "ui" });
  assert.match(denied(decide(command, { gh })) ?? "", /qc review promotion 7/);
  appendRecord(ws.ledgerOf(ws.promo), { ...verdict("branch", "APPROVED"), scope: "promotion" });
  assert.equal(decide(command, { gh }), null);
});

for (const [checkout, head] of [["promo", "feat/x"], ["on", "dev"], ["promo", undefined]]) {
  test(`the ${checkout} checkout keeps the old review rules with head ${head}`, (t) => {
    const ws = workspace(t);
    const cwd = ws[checkout];
    const { gh } = fakeGh(prView(bases.get(cwd), "main", head));
    const command = shell(cwd, `gh pr merge 7 --match-head-commit ${SHA}`);
    assert.match(denied(decide(command, { gh })) ?? "", /no APPROVED branch review/);
    appendRecord(ws.ledgerOf(cwd), { ...verdict("branch", "APPROVED"), scope: "ui" });
    assert.equal(decide(command, { gh }), null);
  });
}

test("promotion PR matching removes origin prefixes", (t) => {
  const ws = workspace(t);
  const { gh } = fakeGh(prView(bases.get(ws.promo), "origin/main", "origin/dev"));
  appendRecord(ws.ledgerOf(ws.promo), { ...verdict("branch", "APPROVED"), scope: "ui" });
  assert.match(denied(decide(shell(ws.promo, `gh pr merge 7 --match-head-commit ${SHA}`), { gh })) ?? "", /qc review promotion 7/);
});

test("a promotion merge refuses an approval of another scope", () => {
  const records = [{ ...verdict("branch", "APPROVED"), scope: "ui" }];
  const reason = mergeVerdict([{ sha: SHA, selector: "7" }], records, "branch", null, "promotion").refusal;
  assert.match(reason ?? "", /scope "promotion"/);
  assert.match(reason ?? "", /qc review promotion 7/);
});

test("a promotion approval keeps another scope's request for changes", () => {
  const records = [
    { ...verdict("branch", "CHANGES_REQUIRED"), scope: "ui" },
    { ...verdict("branch", "APPROVED"), scope: "promotion" },
  ];
  assert.match(mergeVerdict([{ sha: SHA, selector: "7" }], records, "branch", null, "promotion").refusal ?? "", /CHANGES_REQUIRED/);
});

test("a promotion approval permits its merge", () => {
  const records = [{ ...verdict("branch", "APPROVED"), scope: "promotion" }];
  assert.equal(mergeVerdict([{ sha: SHA, selector: "7" }], records, "branch", null, "promotion").refusal, null);
});

test("a merge without a promotion requirement accepts another scope's approval", () => {
  const records = [{ ...verdict("branch", "APPROVED"), scope: "ui" }];
  assert.equal(mergeVerdict([{ sha: SHA, selector: "7" }], records, "branch", null, null).refusal, null);
});

test("a promotion merge skips the direct lane and names a missing PR selector", () => {
  const lane = () => assert.fail("a promotion merge must skip the direct lane");
  assert.match(mergeVerdict([{ sha: SHA }], [], "branch", lane, "promotion").refusal ?? "", /qc review promotion <pr>/);
});

test("a promotion approval cannot bypass a dispatched scope", () => {
  const records = [
    { type: "dispatch", task: false, agentType: "sdd-branch-reviewer", branch: "feat/62-x", head: SHA, scope: "ui" },
    { ...verdict("branch", "APPROVED"), scope: "promotion" },
  ];
  assert.match(mergeVerdict([{ sha: SHA }], records, "branch", null, "promotion").refusal ?? "", /scope "ui"/);
});

test("a small head with no review merges through the direct lane, with a note", (t) => {
  const { dir, head, base } = laneRepo(t);
  const { gh, calls } = fakeGh(prView(base));
  const output = decide(shell(dir, `gh pr merge 7 --squash --match-head-commit ${head}`), { gh });
  assert.equal(denied(output), null);
  assert.deepEqual(calls[0].args, ["pr", "view", "7", "--json", "baseRefName,baseRefOid,headRefName"]);
  assert.match(output?.hookSpecificOutput?.additionalContext ?? "", /merges through the direct lane, with 2 of 20 lines in 1 of 2 files and no review/);
  assert.match(denied(decide(shell(dir, "gh pr merge 7 --squash"))) ?? "", /--match-head-commit <sha>/);
});

test("a review that asked for changes keeps a small head out of the direct lane", (t) => {
  const { dir, head, base, ledger } = laneRepo(t);
  appendRecord(ledger, verdict("task", "CHANGES_REQUIRED", head));
  const reason = denied(decide(shell(dir, `gh pr merge 7 --squash --match-head-commit ${head}`), { gh: fakeGh(prView(base)).gh })) ?? "";
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
  const { dir, head, base } = laneRepo(t);
  const merge = shell(dir, `gh pr merge 7 --squash --match-head-commit ${head}`);
  assert.match(denied(decide(merge, { gh: fakeGh(prView(base, "release/2.0")).gh })) ?? "", /the PR merges into release\/2\.0, and the lane measures against origin\/main/);
  assert.match(denied(decide(merge, { gh: fakeGh(null).gh })) ?? "", /gh cannot read the base branch of the PR/);
});

test("a head that a review path covers merges through the lane after an APPROVED review, and the note names that review", (t) => {
  const { dir, head, base, ledger } = laneRepo(t, { swarm: { dispatch: {}, direct: { reviewPaths: ["**"] } } });
  const merge = shell(dir, `gh pr merge 7 --squash --match-head-commit ${head}`);
  const gh = fakeGh(prView(base)).gh;
  assert.match(denied(decide(merge, { gh })) ?? "", /a\.ts matches swarm\.direct\.reviewPaths/);
  appendRecord(ledger, verdict("task", "APPROVED", head));
  const output = decide(merge, { gh });
  assert.equal(denied(output), null);
  const note = output?.hookSpecificOutput?.additionalContext ?? "";
  assert.match(note, new RegExp(`merges through the direct lane, with 2 of 20 lines in 1 of 2 files and the APPROVED task review of ${head}\.`));
  assert.doesNotMatch(note, /no review/);
});

test("the merge guard judges with the limits of the base, so a loosened checkout does not open the lane", (t) => {
  const { dir, head, base } = laneRepo(t, { swarm: { dispatch: {}, direct: { reviewPaths: ["**"] } } });
  writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {} } }));
  const reason = denied(decide(shell(dir, `gh pr merge 7 --squash --match-head-commit ${head}`), { gh: fakeGh(prView(base)).gh })) ?? "";
  assert.match(reason, /does not apply: a\.ts matches swarm\.direct\.reviewPaths/);
});

test("a head that changes qc.config.json stays out of the direct lane", (t) => {
  const { dir, base } = laneRepo(t);
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" }).trim();
  git("switch", "-q", "-c", "feat/2-y", "origin/main");
  writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {}, direct: { maxLines: 500 } } }));
  git("commit", "-q", "-am", "loosen");
  const merge = shell(dir, `gh pr merge 7 --squash --match-head-commit ${git("rev-parse", "HEAD")}`);
  const reason = denied(decide(merge, { gh: fakeGh(prView(base)).gh })) ?? "";
  assert.match(reason, /does not apply: qc\.config\.json changes on the branch, so it runs the subagent workflow/);
});

test("a base that holds no qc.config.json leaves the merge guard off", (t) => {
  const { dir, head, base } = laneRepo(t, { swarm: { dispatch: {} } }, { tracked: false });
  assert.equal(decide(shell(dir, `gh pr merge 7 --squash --match-head-commit ${head}`), { gh: fakeGh(prView(base)).gh }), null);
});

test("a failed read of qc.config.json at the base denies the merge", (t) => {
  const { dir, head, base } = laneRepo(t);
  const blob = gitIn(dir, "rev-parse", `${base}:qc.config.json`);
  rmSync(path.join(dir, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  const reason = denied(decide(shell(dir, `gh pr merge 7 --squash --match-head-commit ${head}`), { gh: fakeGh(prView(base)).gh })) ?? "";
  assert.match(reason, /git cannot read qc\.config\.json at the PR base/);
});

test("the note states the size against the limits of the base, not the checkout", (t) => {
  const { dir, head, base } = laneRepo(t, { swarm: { dispatch: {}, direct: { maxLines: 5 } } });
  writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {}, direct: { maxLines: 500 } } }));
  const output = decide(shell(dir, `gh pr merge 7 --squash --match-head-commit ${head}`), { gh: fakeGh(prView(base)).gh });
  assert.match(output?.hookSpecificOutput?.additionalContext ?? "", /with 2 of 5 lines in 1 of 2 files and no review/);
});

const gitIn = (dir, ...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" }).trim();
const merge7 = (dir, head) => shell(dir, `gh pr merge 7 --squash --match-head-commit ${head}`);

test("the merge policy at the PR base survives a removed dispatch or a weaker checkout review", (t) => {
  const { dir, head, base, ledger } = laneRepo(t, { swarm: { dispatch: {}, direct: false } });
  appendRecord(ledger, verdict("task", "APPROVED", head));
  for (const config of [{ swarm: {} }, { swarm: { dispatch: {}, review: { merge: "task" } } }]) {
    writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify(config));
    assert.match(denied(decide(merge7(dir, head), { gh: fakeGh(prView(base)).gh })) ?? "", /no APPROVED branch review/);
  }
  appendRecord(ledger, verdict("branch", "APPROVED", head));
  assert.equal(decide(merge7(dir, head), { gh: fakeGh(prView(base)).gh }), null);
});

test("each merge in one command uses its own PR base policy", (t) => {
  const { dir, head, base, ledger } = laneRepo(t, { swarm: { dispatch: {}, direct: false } });
  writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify({ swarm: {} }));
  gitIn(dir, "commit", "-q", "-am", "disable dispatch");
  const offBase = gitIn(dir, "rev-parse", "HEAD");
  const gh = fakeGh((args) => prView(args[2] === "7" ? offBase : base)).gh;
  const command = `gh pr merge 7 --match-head-commit ${head}; gh pr merge 8 --match-head-commit ${head}`;
  assert.match(denied(decide(shell(dir, command), { gh })) ?? "", /no APPROVED branch review/);
  appendRecord(ledger, verdict("branch", "APPROVED", head));
  assert.equal(decide(shell(dir, command), { gh }), null);
});

test("the hook budget includes the reads before the lane and is shared by every merge", (t) => {
  const { dir, head, base } = laneRepo(t);
  gitIn(dir, "remote", "add", "origin", "https://github.com/o/r.git");
  let now = 0;
  t.mock.method(Date, "now", () => (now += 100));
  const timeouts = [];
  const gh = (args, options) => {
    timeouts.push(options.timeoutMs);
    now += 2_000;
    return prView(base);
  };
  decide(shell(dir, `gh pr merge 7 -R o/r --match-head-commit ${head}; gh pr merge 8 --match-head-commit ${head}`), { gh });
  assert.ok(timeouts[0] < 5_900, `the first read gets ${timeouts[0]} ms`);
  assert.ok(timeouts.length < 2 || timeouts[1] < timeouts[0] - 2_000);
});

test("merge records share the hook budget and stop gh reads when it expires", (t) => {
  const ws = workspace(t);
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const timeouts = [];
  const gh = (args, options) => {
    timeouts.push(options.timeoutMs);
    now = 6_001;
    return MERGED;
  };
  decide(shell(ws.on, "gh pr merge 60; gh pr merge 61", "PostToolUse"), { gh });
  assert.deepEqual(timeouts, [6_000]);
});

test("a loosening commit on the local base ref, absent from the PR base commit, does not open the lane", (t) => {
  const strict = { swarm: { dispatch: {}, direct: { reviewPaths: ["**"] } }, worktree: { base: "main" } };
  const { dir, base } = laneRepo(t, strict);
  gitIn(dir, "switch", "-q", "main");
  writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {} }, worktree: { base: "main" } }));
  gitIn(dir, "commit", "-q", "-am", "loosen");
  gitIn(dir, "switch", "-q", "-c", "fix/2-y");
  writeFileSync(path.join(dir, "a.ts"), "one\nthree\n");
  gitIn(dir, "commit", "-q", "-am", "one-line fix");
  const reason = denied(decide(merge7(dir, gitIn(dir, "rev-parse", "HEAD")), { gh: fakeGh(prView(base)).gh })) ?? "";
  assert.match(reason, /does not apply: qc\.config\.json changes on the branch, so it runs the subagent workflow/);
});

test("a stale local base ref does not hide the review paths that the PR base commit sets", (t) => {
  const { dir } = laneRepo(t);
  gitIn(dir, "switch", "-q", "-c", "newbase", "origin/main");
  writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {}, direct: { reviewPaths: ["**"] } } }));
  gitIn(dir, "commit", "-q", "-am", "require reviews");
  const newBase = gitIn(dir, "rev-parse", "HEAD");
  gitIn(dir, "switch", "-q", "feat/1-x");
  gitIn(dir, "rebase", "-q", newBase);
  const head = gitIn(dir, "rev-parse", "HEAD");
  const reason = denied(decide(merge7(dir, head), { gh: fakeGh(prView(newBase)).gh })) ?? "";
  assert.match(reason, /does not apply: a\.ts matches swarm\.direct\.reviewPaths/);
});

test("a PR base commit that the local repository lacks blocks an approved merge and says to fetch", (t) => {
  const { dir, head, ledger } = laneRepo(t);
  appendRecord(ledger, verdict("branch", "APPROVED", head));
  const reason = denied(decide(merge7(dir, head), { gh: fakeGh(prView("1234567890123456789012345678901234567890")).gh })) ?? "";
  assert.match(reason, /the PR base commit 1234567890\w* is not in this repository, so run `git fetch`/);
});

test("a gh answer with no base commit blocks the merge policy check", (t) => {
  const { dir, head } = laneRepo(t);
  const reason = denied(decide(merge7(dir, head), { gh: fakeGh(JSON.stringify({ baseRefName: "main" })).gh })) ?? "";
  assert.match(reason, /gh returned no base commit for the PR/);
});

test("a merge waits while the newest review of any scope on the head asks for changes", () => {
  const sha = "b".repeat(40);
  const records = [
    { type: "verdict", kind: "branch", verdict: "CHANGES_REQUIRED", sha, branch: "f", scope: "a" },
    { type: "verdict", kind: "branch", verdict: "APPROVED", sha, branch: "f", scope: "b" },
  ];
  assert.match(mergeVerdict([{ sha }], records, "branch").refusal ?? "", /CHANGES_REQUIRED/);
  records.push({ type: "verdict", kind: "branch", verdict: "APPROVED", sha, branch: "f", scope: "a" });
  assert.equal(mergeVerdict([{ sha }], records, "branch").refusal, null);
});

test("a merge needs an APPROVED review of every scope dispatched on the branch", () => {
  const sha = "c".repeat(40);
  const records = [
    { type: "dispatch", task: false, agentType: "sdd-branch-reviewer", branch: "f", head: sha, scope: "a" },
    { type: "dispatch", task: false, agentType: "sdd-branch-reviewer", branch: "f", head: sha, scope: "b" },
    { type: "verdict", kind: "branch", verdict: "APPROVED", sha, branch: "f", scope: "a" },
  ];
  assert.match(mergeVerdict([{ sha }], records, "branch").refusal ?? "", /scope "b"/);
  records.push({ type: "verdict", kind: "branch", verdict: "APPROVED", sha, branch: "f", scope: "b" });
  assert.equal(mergeVerdict([{ sha }], records, "branch").refusal, null);
});
