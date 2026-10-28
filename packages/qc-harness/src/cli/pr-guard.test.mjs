import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { decidePr } from "./pr-guard.mjs";
import { appendLeg } from "./legs.mjs";

function workspace(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "qc-pr-guard-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q");
  git("checkout", "-qb", "feat/206-pr-guard");
  git("remote", "add", "origin", "https://github.com/o/r.git");
  writeFileSync(path.join(cwd, "qc.config.json"), "{}");
  return cwd;
}
const call = (cwd, command, extra = {}) => ({ cwd, tool_name: "Bash", hook_event_name: "PreToolUse", tool_input: { command }, ...extra });
const reason = (out) => out?.hookSpecificOutput?.permissionDecisionReason;
const emptyGh = () => "[]";

test("create requires the controller and a draft", (t) => {
  const cwd = workspace(t);
  assert.match(reason(decidePr(call(cwd, "gh pr create --draft", { agent_id: "a" }), { gh: emptyGh })), /sub-branch.*qc integrate/);
  assert.match(reason(decidePr(call(cwd, "gh pr create"), { gh: emptyGh })), /--draft/);
  assert.equal(decidePr(call(cwd, "gh pr create --draft"), { gh: emptyGh }), null);
});

test("only Bash PreToolUse in a configured origin checkout is guarded", (t) => {
  const cwd = workspace(t);
  for (const command of ["echo 'gh pr create'", "gh pr view", "gh pr create -R other/repo", "GH_REPO=other/repo gh pr create"]) {
    assert.equal(decidePr(call(cwd, command), { gh: () => assert.fail("foreign call") }), null);
  }
  for (const extra of [{ tool_name: "Read" }, { hook_event_name: "PostToolUse" }]) assert.equal(decidePr(call(cwd, "gh pr create", extra)), null);
  rmSync(path.join(cwd, "qc.config.json"));
  assert.equal(decidePr(call(cwd, "gh pr create")), null);
});

test("open PR references match whole issue numbers from the branch or body", (t) => {
  const cwd = workspace(t);
  const gh = (args) => {
    assert.deepEqual(args.slice(0, 3), ["pr", "list", "--state"]);
    assert.ok(args.includes("o/r"));
    return JSON.stringify([{ number: 9, headRefName: "feat/206-existing", body: "" }]);
  };
  assert.match(reason(decidePr(call(cwd, "gh pr create --draft"), { gh })), /#206.*#9/);
  for (const body of ["Refs #207", "Fixes #207"]) {
    assert.match(reason(decidePr(call(cwd, `gh pr create --draft --body '${body}'`), { gh: () => JSON.stringify([{ number: 8, body: "Refs #207", headRefName: "other" }]) })), /#207.*#8/);
  }
  assert.equal(decidePr(call(cwd, "gh pr create --draft"), { gh: () => JSON.stringify([{ number: 8, body: "Refs #2060", headRefName: "other" }]) }), null);
});

test("body files, explicit heads, and repository flags preserve issue checks", (t) => {
  const cwd = workspace(t);
  writeFileSync(path.join(cwd, "body.md"), "Fixes #207");
  const gh = () => JSON.stringify([{ number: 8, body: "Refs #207", headRefName: "other" }]);
  for (const command of ["gh pr create -d -F body.md", "gh -R o/r pr create --draft --head feat/207-new", "gh pr create --draft --body='Refs #207'", "gh pr --repo=o/r create -d -Fbody.md", "gh pr -Ro/r create -d -F body.md"]) {
    assert.match(reason(decidePr(call(cwd, command), { gh })), /#207/);
  }
});

test("failed or malformed open PR reads refuse in one line", (t) => {
  const cwd = workspace(t);
  for (const gh of [() => { throw new Error("offline\nsecret"); }, () => "{}", () => "bad"]) {
    const message = reason(decidePr(call(cwd, "gh pr create --draft"), { gh }));
    assert.match(message, /cannot list/i);
    assert.equal(message.split("\n").length, 1);
  }
});

test("ready checks the PR head and reports missing legs, three hits, and commands", (t) => {
  const cwd = workspace(t);
  const gh = (args) => {
    assert.deepEqual(args, ["pr", "view", "12", "-R", "o/r", "--json", "headRefOid"]);
    return JSON.stringify({ headRefOid: "a".repeat(40) });
  };
  const problems = (root, head) => {
    assert.equal(root, cwd);
    assert.equal(head, "a".repeat(40));
    return { missing: ["linux", "windows"], hits: [1, 2, 3, 4].map((n) => ({ file: `f${n}`, line: n, reason: "risk" })) };
  };
  const message = reason(decidePr(call(cwd, "gh pr ready 12"), { gh, problems }));
  assert.match(message, /linux.*windows/);
  assert.match(message, /f1:1.*f2:2.*f3:3/);
  assert.doesNotMatch(message, /f4/);
  assert.match(message, /qc ci-preview --os linux/);
  assert.match(message, /qc ci-preview --os windows/);
  assert.ok(message.split("\n").length <= 2);
  assert.equal(decidePr(call(cwd, "gh pr ready 12"), { gh, problems: () => ({ missing: [], hits: [] }) }), null);
  assert.equal(decidePr(call(cwd, "gh pr ready 12 --undo"), { gh: () => assert.fail("undo") }), null);
});

test("ready uses the ledger for the PR head even when the checkout head differs", (t) => {
  const cwd = workspace(t);
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git("config", "user.name", "qc");
  git("config", "user.email", "qc@example.com");
  git("config", "commit.gpgsign", "false");
  git("add", ".");
  git("commit", "-qm", "base");
  git("branch", "base");
  writeFileSync(path.join(cwd, "qc.config.json"), JSON.stringify({ check: { base: "base" }, ready: { platforms: ["linux", "windows"] } }));
  writeFileSync(path.join(cwd, "risk.mjs"), "process.platform;\n");
  git("add", ".");
  git("commit", "-qm", "risk");
  const head = git("rev-parse", "HEAD");
  git("checkout", "-q", "base");
  writeFileSync(path.join(cwd, "qc.config.json"), JSON.stringify({ check: { base: "base" }, ready: { platforms: ["linux", "windows"] } }));
  const gh = () => JSON.stringify({ headRefOid: head });
  assert.match(reason(decidePr(call(cwd, "gh pr ready 12"), { gh })), /linux, windows/);
  appendLeg(cwd, { head, os: "linux", source: "local" });
  assert.match(reason(decidePr(call(cwd, "gh pr ready 12"), { gh })), /missing platform legs: windows/);
  appendLeg(cwd, { head, os: "windows", source: "preview" });
  assert.equal(decidePr(call(cwd, "gh pr ready 12"), { gh }), null);
});

test("wrappers, nested shells, changed directories, and multiple calls keep the guard", (t) => {
  const cwd = workspace(t);
  for (const command of ["env GH_REPO=o/r command gh pr create", "bash -lc 'gh pr create'", "gh pr view; gh pr create", "export GH_REPO=o/r; gh pr create", "gh pr create --title '--draft'", "gh pr create --draft=false"]) {
    assert.match(reason(decidePr(call(cwd, command), { gh: emptyGh })), /--draft/);
  }
  const parent = path.dirname(cwd).replaceAll("\\", "/");
  assert.match(reason(decidePr(call(parent, `cd '${cwd.replaceAll("\\", "/")}'; gh pr create`), { gh: emptyGh })), /--draft/);
  assert.equal(decidePr(call(cwd, "gh pr ready https://github.com/foreign/repo/pull/1"), { gh: () => assert.fail("foreign PR") }), null);
  assert.equal(decidePr(call(cwd, "gh pr ready https://github.com/foreign/repo/pull/1 -R o/r"), { gh: () => assert.fail("foreign URL takes precedence") }), null);
  assert.match(reason(decidePr(call(cwd, "gh pr ready https://github.com/o/r/pull/1 -R foreign/repo"), {
    gh: () => JSON.stringify({ headRefOid: "a".repeat(40) }),
    problems: () => ({ missing: ["linux"], hits: [] }),
  })), /missing platform legs: linux/);
});

test("the Bash PreToolUse hook runs the PR guard", () => {
  const hooks = JSON.parse(readFileSync(new URL("../../../../hooks/hooks.json", import.meta.url), "utf8"));
  const entry = hooks.hooks.PreToolUse.find((entry) => entry.hooks.some((hook) => hook.command.includes("/pr-guard.mjs")));
  assert.equal(entry.matcher, "Bash");
  assert.ok(entry.hooks.find((hook) => hook.command.includes("/pr-guard.mjs")).timeout >= 10);
});

test("ready fails closed when the head or legs cannot be read", (t) => {
  const cwd = workspace(t);
  for (const gh of [() => { throw new Error("offline"); }, () => "{}", () => '{"headRefOid":"bad"}']) {
    assert.match(reason(decidePr(call(cwd, "gh pr ready"), { gh })), /cannot check/i);
  }
});

test("the trigger reads stdin and emits a hook denial", (t) => {
  const cwd = workspace(t);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./pr-guard.mjs", import.meta.url))], { input: JSON.stringify(call(cwd, "gh pr create")), encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(reason(JSON.parse(result.stdout)), /--draft/);
});
