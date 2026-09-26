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
