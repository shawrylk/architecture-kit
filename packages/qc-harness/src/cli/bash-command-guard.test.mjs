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
    "node src/cli/worktree-gate.mjs",
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

/** The adopted checkout plus a second adopted checkout, `kit`, and a checkout with no config. Forward slashes, as a Bash command spells a path. */
function twoRepos(t) {
  const ws = workspace(t);
  const kit = path.join(path.dirname(ws.adopted), "kit");
  mkdirSync(kit);
  execFileSync("git", ["init", "-q"], { cwd: kit, stdio: "pipe" });
  writeFileSync(path.join(kit, "qc.config.json"), "{}");
  return { ...ws, kit, slash: (dir) => dir.replaceAll("\\", "/") };
}

test("a worktree add judges the repository the command targets, through -C, cd, or Set-Location", (t) => {
  const ws = twoRepos(t);
  const kit = ws.slash(ws.kit);
  for (const command of [
    `git -C ${kit} worktree add ${kit}/.worktree/x -b feat/x`,
    `git -C ${kit} worktree add .worktree/x`,
    `cd ${kit} && git worktree add .worktree/x`,
    `cd ${kit} && git worktree add ${kit}/.worktree/x`,
    `bash -c 'cd ${kit} && git worktree add .worktree/x'`,
  ]) {
    assert.equal(decide(bash(ws.adopted, command)), null, command);
  }
  for (const command of [`Set-Location ${kit}; git worktree add .worktree/x`, `Set-Location ${kit}; git worktree add ${kit}/.worktree/x`, `git -C ${kit} worktree add .worktree/x`]) {
    assert.equal(decide(powershell(ws.adopted, command)), null, command);
  }
});

test("a worktree add in the targeted repository is still held to that repository's folder, and the deny names it", (t) => {
  const ws = twoRepos(t);
  const kit = ws.slash(ws.kit);
  for (const command of [`git -C ${kit} worktree add ../x`, `git -C ${kit} worktree add ${ws.slash(ws.adopted)}/.worktree/x`, `cd ${kit} && git worktree add x`]) {
    const reason = reasonOf(decide(bash(ws.adopted, command))) ?? "";
    assert.match(reason, /npx qc worktree add <name> <branch>/, command);
    assert.ok(reason.includes(`The folder is ${path.join(ws.kit, ".worktree")}.`), `${command}: ${reason}`);
  }
});

test("an absolute worktree path alone does not name the repository: git adds to the session's repository", (t) => {
  const ws = twoRepos(t);
  const kit = ws.slash(ws.kit);
  for (const command of [`git worktree add ${kit}/.worktree/x`, `git worktree add ${kit}/x`, `git worktree add ../x`]) {
    const reason = reasonOf(decide(bash(ws.adopted, command))) ?? "";
    assert.ok(reason.includes(`The folder is ${path.join(ws.adopted, ".worktree")}.`), `${command}: ${reason}`);
  }
  assert.equal(decide(bash(ws.adopted, `git worktree add ${ws.slash(ws.adopted)}/.worktree/x`)), null);
});

/** The refusal for an explicit git directory or work tree: it says to run `git worktree add` from inside the target repository. */
const explicitDirReason = (output) => {
  const reason = reasonOf(output) ?? "";
  assert.match(reason, /--git-dir|GIT_DIR|--work-tree|GIT_WORK_TREE/, reason);
  assert.match(reason, /from inside the target repository/, reason);
  assert.match(reason, /-C/, reason);
  return reason;
};

test("a worktree add with --git-dir, GIT_DIR, --work-tree, or GIT_WORK_TREE is refused from a guarded session", (t) => {
  const ws = twoRepos(t);
  const kit = ws.slash(ws.kit);
  const plain = ws.slash(ws.plain);
  const adopted = ws.slash(ws.adopted);
  for (const command of [
    `git --git-dir=${kit}/.git worktree add ${kit}/.worktree/x`,
    `git --git-dir ${kit}/.git worktree add ${kit}/.worktree/x`,
    `GIT_DIR=${kit}/.git git worktree add ${kit}/.worktree/x`,
    `git -C ${kit} --git-dir=${kit}/.git worktree add .worktree/x`,
    `git -C ${plain} --git-dir=${kit}/.git worktree add ${kit}/.worktree/x`,
    `git --git-dir=${kit}/.git worktree add ../x`,
    `GIT_DIR=${kit}/.git git worktree add ../x`,
    `git --git-dir=${kit}/.git worktree add .worktree/x`,
    `GIT_DIR=${kit}/.git git worktree add .worktree/x`,
    `cd ${plain} && git --git-dir=${kit}/.git worktree add .worktree/x`,
    `git -C ${plain} --git-dir=${adopted}/.git worktree add ../x`,
    `git --git-dir=${plain}/.git worktree add ../x`,
    `git --git-dir=${adopted}/.git worktree add ${adopted}/.worktree/x`,
    `env GIT_DIR=${kit}/.git git worktree add ../x`,
    `bash -c 'git --git-dir=${kit}/.git worktree add ../x'`,
    `git --work-tree=${plain} worktree add ../x`,
    `git --work-tree ${plain} worktree add ../x`,
    `GIT_WORK_TREE=${plain} git worktree add ../x`,
    `git --work-tree=${kit} worktree add ../x`,
    `GIT_WORK_TREE=${kit} git worktree add ../x`,
    `git --work-tree=${plain} worktree add .worktree/x`,
  ]) {
    explicitDirReason(decide(bash(ws.adopted, command)));
  }
  explicitDirReason(decide(powershell(ws.adopted, `git --git-dir=${kit}/.git worktree add ../x`)));
});

test("git resolves a relative git dir from the working directory after every -C, so these probes are refused", (t) => {
  const ws = twoRepos(t);
  const adopted = ws.slash(ws.adopted);
  const plain = ws.slash(ws.plain);
  // Real git adds ../x1 as a worktree of `adopted` from these.
  for (const command of [
    `cd ${plain} && git --git-dir=.git -C ${adopted} worktree add ../x1`,
    `cd ${plain} && GIT_DIR=.git git -C ${adopted} worktree add ../x1`,
  ]) {
    explicitDirReason(decide(bash(ws.adopted, command)));
  }
});

test("an explicit git dir on a command other than worktree add is not refused by the worktree rule", (t) => {
  const ws = twoRepos(t);
  const kit = ws.slash(ws.kit);
  for (const command of [`git --git-dir=${kit}/.git status`, `git --git-dir=${kit}/.git worktree list`, `GIT_DIR=${kit}/.git git log`]) {
    assert.equal(decide(bash(ws.adopted, command)), null, command);
  }
});

test("a worktree add in a repository with no qc.config.json is not guarded", (t) => {
  const ws = twoRepos(t);
  const plain = ws.slash(ws.plain);
  for (const command of [`git -C ${plain} worktree add ../x`, `cd ${plain} && git worktree add ../x`]) {
    assert.equal(decide(bash(ws.adopted, command)), null, command);
  }
  assert.equal(decide(bash(ws.plain, "git worktree add ../x")), null, "a session in it is not guarded either");
});

test("a worktree add is refused when its command text sets GIT_DIR, GIT_WORK_TREE, core.worktree, or core.bare in any segment", (t) => {
  const ws = twoRepos(t);
  const kit = ws.slash(ws.kit);
  for (const command of [
    `export GIT_DIR=${kit}/.git; git worktree add .worktree/x`,
    `export GIT_WORK_TREE=${kit}; cd ${kit} && git worktree add .worktree/x`,
    `env GIT_DIR=${kit}/.git bash -c 'cd ${kit}'; git worktree add .worktree/x`,
    `git worktree add .worktree/x; export GIT_DIR=${kit}/.git`,
    `export GIT_DIR=${kit}/.git; bash -c 'git worktree add .worktree/x'`,
    `bash -c 'export GIT_DIR=${kit}/.git'; git worktree add .worktree/x`,
    `git -c core.worktree=${kit} worktree add .worktree/x`,
    `git -c core.bare=true worktree add .worktree/x`,
    `git config core.worktree ${kit} && git worktree add .worktree/x`,
    `set GIT_DIR=${kit}/.git && git worktree add .worktree/x`,
    `export git_dir=${kit}/.git; git worktree add .worktree/x`,
    `export GIT_COMMON_DIR=${kit}/.git; git worktree add .worktree/x`,
  ]) {
    explicitDirReason(decide(bash(ws.adopted, command)));
  }
  for (const command of [
    `$env:GIT_DIR = "${kit}/.git"; git worktree add .worktree/x`,
    `$env:GIT_WORK_TREE = "${kit}"; Set-Location ${kit}; git worktree add .worktree/x`,
    `git -c core.worktree=${kit} worktree add .worktree/x`,
    `$env:git_dir="${kit}/.git"; git worktree add .worktree/x`,
  ]) {
    explicitDirReason(decide(powershell(ws.adopted, command)));
  }
});

test("a worktree add with none of those settings still passes, and so does a mention without a worktree add", (t) => {
  const ws = twoRepos(t);
  const kit = ws.slash(ws.kit);
  assert.equal(decide(bash(ws.adopted, "git worktree add .worktree/x")), null);
  assert.equal(decide(bash(ws.adopted, `export GIT_DIR=${kit}/.git; git status`)), null);
  assert.equal(decide(bash(ws.adopted, `git -c core.bare=true status`)), null);
  assert.equal(decide(bash(ws.plain, `export GIT_DIR=${kit}/.git; git worktree add ../x`)), null, "a repository with no qc.config.json is not guarded");
});

/** The refusal for a path that holds an unexpanded variable: it says to write the path literally. */
const variableReason = (output) => {
  const reason = reasonOf(output) ?? "";
  assert.match(reason, /literally/, reason);
  assert.match(reason, /variable/, reason);
  return reason;
};

test("a worktree add after a -C, cd, or Set-Location path with an unexpanded variable is refused, and the reason says to write the path literally", (t) => {
  const ws = twoRepos(t);
  const kit = ws.slash(ws.kit);
  for (const command of [
    "git -C $K worktree add .worktree/x",
    "git -C ${K} worktree add .worktree/x",
    `git -C "$HOME/kit" worktree add .worktree/x`,
    "cd $K && git worktree add .worktree/x",
    "cd ${K}/sub && git worktree add .worktree/x",
    "cd $(git rev-parse --show-toplevel) && git worktree add .worktree/x",
    `bash -c 'cd $K && git worktree add .worktree/x'`,
    "cd %K% && git worktree add .worktree/x",
    `cd $K; cd sub; git worktree add .worktree/x`,
    "cd `pwd` && git worktree add .worktree/x",
    "cd $(pwd)/sub && git worktree add .worktree/x",
    "pushd $(pwd) && git worktree add .worktree/x",
    "git -C $(git rev-parse --show-toplevel) worktree add ../out",
    "git -C `pwd` worktree add ../out",
  ]) {
    variableReason(decide(bash(ws.adopted, command)));
  }
  for (const command of [
    "Set-Location $env:K; git worktree add .worktree/x",
    "Set-Location $K; git worktree add .worktree/x",
    "git -C $env:K worktree add .worktree/x",
    "cd %K%; git worktree add .worktree/x",
    "Set-Location (Join-Path $K 'sub'); git worktree add .worktree/x",
    "Push-Location ($env:K + '\\sub'); git worktree add .worktree/x",
    "Set-Location -Path (Join-Path $K sub); git worktree add .worktree/x",
    "Set-Location -LiteralPath (Get-Location); git worktree add .worktree/x",
    "cd (Resolve-Path ..); git worktree add .worktree/x",
    "Set-Location $(Join-Path $K sub); git worktree add .worktree/x",
    "git -C (Join-Path $K 'x') worktree add ../out",
    "git -C $(Get-Location) worktree add ../out",
  ]) {
    variableReason(decide(powershell(ws.adopted, command)));
  }
  // A literal path after the variable names the repository again.
  assert.equal(decide(bash(ws.adopted, `cd $K; cd ${kit} && git worktree add .worktree/x`)), null);
});

test("a variable in a path of a command that adds no worktree, or in the worktree path alone, is no refusal for it", (t) => {
  const ws = twoRepos(t);
  for (const command of ["cd $K && git status", "git -C $K worktree list", "cd $HOME && ls", "git worktree add .worktree/$NAME"]) {
    assert.doesNotMatch(reasonOf(decide(bash(ws.adopted, command))) ?? "", /literally/, command);
  }
  const plain = ws.slash(ws.plain);
  assert.equal(decide(bash(ws.plain, "cd $K && git worktree add ../x")), null, "a repository with no qc.config.json is not guarded");
  assert.equal(decide(bash(ws.adopted, `git -C ${plain} worktree add ../x`)), null);
});
