import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decide } from "./bash-command-guard.mjs";

const GUARD = fileURLToPath(new URL("./bash-command-guard.mjs", import.meta.url));

/** An adopted checkout and a checkout with no config. */
function workspace(t) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-bash-command-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const adopted = path.join(base, "adopted");
  const plain = path.join(base, "plain");
  for (const dir of [adopted, plain]) {
    mkdirSync(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" });
  }
  writeFileSync(path.join(adopted, "qc.config.json"), "{}");
  return { adopted, plain };
}

const bash = (cwd, command) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd, tool_input: { command } });
const reasonOf = (output) => (output?.hookSpecificOutput?.permissionDecision === "deny" ? output.hookSpecificOutput.permissionDecisionReason : null);

test("a commit or push that skips the git hooks is denied", (t) => {
  const ws = workspace(t);
  for (const command of [
    "git commit --no-verify -m x",
    "git commit --no-veri -m x",
    "git push --no-verify",
    "git push origin feat/x --no-verify",
    "git commit -n -m x",
    "git commit -nm x",
    "git commit -anm x",
    "cd repo && git add -A && GIT_PAGER=cat git -C repo commit --no-verify -F -",
  ]) {
    assert.match(reasonOf(decide(bash(ws.adopted, command))) ?? "", /skips the git hooks/, command);
  }
});

test("git commit --no-verify inside bash -lc, env, sudo, and an if block is refused", (t) => {
  const ws = workspace(t);
  for (const command of [
    `bash -lc 'git commit --no-verify -m x'`,
    `bash -ic "git commit -n -m x"`,
    `sh -c 'git push --no-verify'`,
    `env git commit -n -m x`,
    `env -i HOME=/h git commit --no-verify -m x`,
    `sudo -u ci git push --no-verify`,
    `command git commit -n -m x`,
    `timeout 60 git commit --no-verify -m x`,
    `eval 'git commit --no-verify -m x'`,
    `eval git commit -n -m x`,
    `if true; then git commit --no-verify -m x; fi`,
    `if git diff --quiet; then git push --no-verify; fi`,
    `env bash -lc 'if true; then git commit -n -m x; fi'`,
    `sudo env git -c core.hooksPath=/dev/null commit -m x`,
  ]) {
    assert.match(reasonOf(decide(bash(ws.adopted, command))) ?? "", /skips the git hooks|core\.hooksPath/, command);
  }
  for (const command of [`bash -lc 'git commit -m x'`, `env git status`, `if true; then git commit -m x; fi`, `eval 'git log'`]) {
    assert.equal(decide(bash(ws.adopted, command)), null, command);
  }
});

test("a git call that points core.hooksPath elsewhere is denied", (t) => {
  const ws = workspace(t);
  for (const command of ["git -c core.hooksPath=/dev/null commit -m x", "git -c core.hookspath= push"]) {
    assert.match(reasonOf(decide(bash(ws.adopted, command))) ?? "", /core\.hooksPath/, command);
  }
});

test("a hand run of a hook script is denied, and the reason names the lease", (t) => {
  const ws = workspace(t);
  for (const command of [
    "node packages/qc-harness/src/cli/work-order-guard.mjs < input.json",
    `echo '{}' | node "C:/kit/packages/qc-harness/src/cli/budget-guard.mjs"`,
    "node ./bash-edit-guard.mjs",
    "node.exe src/cli/worktree-isolation.mjs",
    "bash hooks/pre-edit-guard.sh",
    "./hooks/pre-edit-guard.sh < input.json",
    "node packages/qc-harness/src/cli/report-stop.mjs < stop.json",
    "node ./merge-guard.mjs",
    "node src/cli/issue-gate.mjs",
    "node src/cli/plan-stop.mjs",
    "node src/cli/controller-guard.mjs",
  ]) {
    assert.match(reasonOf(decide(bash(ws.adopted, command))) ?? "", /writes a lease/, command);
  }
});

test("a message, a dry run, a test run and a read pass", (t) => {
  const ws = workspace(t);
  for (const command of [
    'git commit -m "-n is fine"',
    'git commit -m "handle --no-verify" --author "a <a@b.c>"',
    "git commit -mn",
    "git commit -uno -m x",
    "git push -n",
    "git log --oneline -n 5",
    "node --test packages/qc-harness/src/cli/work-order-guard.test.mjs",
    "node --test src/cli && node src/cli/budget-guard.mjs < stub.json",
    "npx vitest run src/work-order-guard.mjs",
    "cat packages/qc-harness/src/cli/work-order-guard.mjs",
    "git -c core.autocrlf=false commit -m x",
  ]) {
    assert.equal(decide(bash(ws.adopted, command)), null, command);
  }
});

test("a repository with no qc.config.json is never guarded", (t) => {
  const ws = workspace(t);
  assert.equal(decide(bash(ws.plain, "git commit --no-verify -m x")), null);
});

test("the hook process prints the deny", (t) => {
  const ws = workspace(t);
  const input = JSON.stringify(bash(ws.adopted, "git push --no-verify"));
  const result = spawnSync(process.execPath, [GUARD], { input, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
});

const powershell = (cwd, command) => ({ ...bash(cwd, command), tool_name: "PowerShell" });

test("a PowerShell command is held to the same rules as a Bash one", (t) => {
  const ws = workspace(t);
  const denied = {
    "skips the git hooks": [
      "git commit --no-verify -m x",
      "git commit -nm x",
      "git push --no-verify",
      String.raw`Set-Location C:\repo; git commit -n -m x`,
      "git --% commit --no-verify",
      "& git.exe commit --no-verify -m x",
      'pwsh -NoProfile -Command "git commit --no-verify -m x"',
      "bash -c 'git push --no-verify'",
    ],
    "core\.hooksPath": ["git -c core.hooksPath= commit -m x", "git -c core.hooksPath=NUL push"],
    "writes a lease": [
      String.raw`& node C:\kit\packages\qc-harness\src\cli\work-order-guard.mjs`,
      String.raw`Get-Content input.json | node .\budget-guard.mjs`,
      "bash hooks/pre-edit-guard.sh",
    ],
  };
  for (const [reason, commands] of Object.entries(denied)) {
    for (const command of commands) {
      assert.match(reasonOf(decide(powershell(ws.adopted, command))) ?? "", new RegExp(reason), command);
    }
  }
  for (const command of [
    'git commit -m "-n is fine"',
    "git log -n 5",
    "git push -n",
    String.raw`node --test packages\qc-harness\src\cli\work-order-guard.test.mjs`,
    "Get-Content packages/qc-harness/src/cli/work-order-guard.mjs",
    'pwsh -Command "git status"',
  ]) {
    assert.equal(decide(powershell(ws.adopted, command)), null, command);
  }
});

test("the deny names the tool it guarded", (t) => {
  const ws = workspace(t);
  assert.match(reasonOf(decide(powershell(ws.adopted, "git push --no-verify"))), /^PowerShell command guard:/);
});

const outsideFolder = (output) => /npx qc worktree add <name> <branch>/.test(reasonOf(output) ?? "");

test("git worktree add to a path outside .worktree/ of the main checkout is refused, and names qc worktree add", (t) => {
  const ws = workspace(t);
  for (const command of [
    "git worktree add ../x",
    "git worktree add -b b ../x origin/main",
    "git worktree add -B b --lock --reason why ../x",
    "git -C .. worktree add x",
    "cd .. && git worktree add x",
    "git worktree add .worktree/a/b",
    "git worktree add x",
    `bash -c 'git worktree add ../x'`,
    "git worktree add -- ../x",
  ]) {
    assert.ok(outsideFolder(decide(bash(ws.adopted, command))), command);
  }
});

test("git worktree add under .worktree/, qc worktree add, and other worktree commands pass", (t) => {
  const ws = workspace(t);
  for (const command of [
    "git worktree add .worktree/x",
    "git worktree add -b feat/1-x .worktree/x origin/main",
    "git worktree add --detach -f .worktree/x HEAD",
    "cd .worktree && git worktree add x",
    "cd .. && git worktree add adopted/.worktree/x",
    `git -C .. worktree add "${path.join(ws.adopted, ".worktree", "x")}"`,
    "npx qc worktree add x feat/1-x",
    "git worktree list",
    "git worktree remove ../x",
  ]) {
    assert.equal(decide(bash(ws.adopted, command)), null, command);
  }
});

test("a PowerShell git worktree add is held to the same folder", (t) => {
  const ws = workspace(t);
  for (const command of [String.raw`git worktree add ..\x`, String.raw`git worktree add -B b ..\x origin/main`, "Set-Location ..; git worktree add x"]) {
    assert.ok(outsideFolder(decide(powershell(ws.adopted, command))), command);
  }
  for (const command of [String.raw`git worktree add .worktree\x`, String.raw`Set-Location .worktree; git worktree add x`]) {
    assert.equal(decide(powershell(ws.adopted, command)), null, command);
  }
});

test("worktree.dir moves the folder, and worktree.enforce false turns the rule off", (t) => {
  const ws = workspace(t);
  writeFileSync(path.join(ws.adopted, "qc.config.json"), JSON.stringify({ worktree: { dir: "trees" } }));
  assert.ok(outsideFolder(decide(bash(ws.adopted, "git worktree add .worktree/x"))));
  assert.equal(decide(bash(ws.adopted, "git worktree add trees/x")), null);
  writeFileSync(path.join(ws.adopted, "qc.config.json"), JSON.stringify({ worktree: { enforce: false } }));
  assert.equal(decide(bash(ws.adopted, "git worktree add ../x")), null);
});

test("inside a linked worktree, the folder is the main checkout's", (t) => {
  const ws = workspace(t);
  execFileSync("git", ["-c", "user.name=qc", "-c", "user.email=qc@example.com", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: ws.adopted, stdio: "pipe" });
  const linked = path.join(ws.adopted, ".worktree", "wt");
  execFileSync("git", ["worktree", "add", "-q", linked], { cwd: ws.adopted, stdio: "pipe" });
  writeFileSync(path.join(linked, "qc.config.json"), "{}");
  assert.equal(decide(bash(linked, "git worktree add ../x")), null);
  assert.ok(outsideFolder(decide(bash(linked, "git worktree add x"))), "a worktree nested in a worktree is refused");
});
