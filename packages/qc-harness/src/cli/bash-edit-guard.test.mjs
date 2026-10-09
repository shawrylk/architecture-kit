import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { changedPaths, report } from "./bash-edit-guard.mjs";

/**
 * A primary checkout on main that turns isolation on, a linked worktree whose work order declares
 * `src/**`, a checkout with no config, and a folder in no checkout.
 */
function workspace(t) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-bash-guard-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  const primary = path.join(base, "primary");
  const linked = path.join(base, "linked");
  const plain = path.join(base, "plain");
  const outside = path.join(base, "outside");
  for (const dir of [primary, plain, outside]) mkdirSync(dir);
  git(primary, "init", "-q", "-b", "main");
  writeFileSync(path.join(primary, "qc.config.json"), JSON.stringify({ swarm: { isolation: { require: "branch" } } }));
  writeFileSync(path.join(primary, ".gitignore"), "*.local.json\n");
  git(primary, "add", ".");
  git(primary, "-c", "user.name=qc", "-c", "user.email=qc@example.com", "commit", "-q", "-m", "init");
  git(primary, "worktree", "add", "-q", linked, "-b", "feat/work-order");
  mkdirSync(path.join(linked, ".claude"));
  writeFileSync(path.join(linked, ".claude", "work-order.local.json"), JSON.stringify({ paths: ["src/**"] }));
  git(plain, "init", "-q", "-b", "main");
  const put = (root, rel) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), "changed\n");
  };
  return { primary, linked, plain, outside, put };
}

const bash = (cwd, command) => ({ hook_event_name: "PostToolUse", tool_name: "Bash", cwd, tool_input: { command } });
const contextOf = (output) => output?.hookSpecificOutput?.additionalContext ?? "";
const powershell = (cwd, command) => ({ ...bash(cwd, command), tool_name: "PowerShell" });

test("a PowerShell write outside the declared paths is reported, and a read-only verb skips the check", async (t) => {
  const ws = workspace(t);
  ws.put(ws.linked, "docs/b.md");
  const output = await report(powershell(ws.linked, "Set-Content -Path docs\\b.md -Value changed"), ws.linked);
  assert.match(contextOf(output), /docs\/b\.md: outside the work order's declared paths/);
  assert.equal(await report(powershell(ws.linked, "Get-ChildItem docs | Select-String changed"), ws.linked), null);
});

test("a PowerShell location change names the checkout to inspect", async (t) => {
  const ws = workspace(t);
  ws.put(ws.linked, "docs/b.md");
  const output = await report(powershell(ws.outside, `Set-Location '${ws.linked}'; New-Item docs\\b.md`), ws.linked);
  assert.match(contextOf(output), /docs\/b\.md/);
});

test("a write inside the work order's declared paths is silent", async (t) => {
  const ws = workspace(t);
  ws.put(ws.linked, "src/a.ts");
  assert.equal(await report(bash(ws.linked, "node scripts/codemod.mjs"), ws.linked), null);
});

test("a write outside the declared paths is reported with the path and the rule, as model-visible context", async (t) => {
  const ws = workspace(t);
  ws.put(ws.linked, "src/a.ts");
  ws.put(ws.linked, "docs/b.md");
  const output = await report(bash(ws.linked, "sed -i 's/a/b/' docs/b.md"), ws.linked);
  assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
  const text = contextOf(output);
  assert.match(text, /docs\/b\.md/);
  assert.doesNotMatch(text, /src\/a\.ts/);
  assert.match(text, /work-order\.local\.json/);
  assert.match(text, /src\/\*\*/);
  assert.match(text, /does not revert/);
  // Status also lists changes made before the command, in a checkout other sessions can share.
  assert.match(text, /uncommitted changes/);
  assert.match(text, /only if your work order made it/);
  assert.match(text, /stop and tell the orchestrator/);
});

test("a change on a protected branch is reported with no work order, and an ignored file is not", async (t) => {
  const ws = workspace(t);
  ws.put(ws.primary, "src/a.ts");
  ws.put(ws.primary, ".claude/settings.local.json");
  const text = contextOf(await report(bash(ws.primary, "python fix.py"), ws.primary));
  assert.match(text, /src\/a\.ts/);
  assert.match(text, /protected branch "main"/);
  assert.doesNotMatch(text, /settings\.local\.json/);
});

test("a read-only command is skipped, even with an out-of-scope change in the checkout", async (t) => {
  const ws = workspace(t);
  ws.put(ws.linked, "docs/b.md");
  assert.equal(await report(bash(ws.linked, "git status && cat docs/b.md | grep x"), ws.linked), null);
});

test("git -C names the checkout the command changed, whatever the session's directory", async (t) => {
  const ws = workspace(t);
  ws.put(ws.primary, "src/a.ts");
  const text = contextOf(await report(bash(ws.outside, `git -C "${ws.primary}" apply fix.patch`), ws.outside));
  assert.match(text, /src\/a\.ts/);
  assert.match(text, /protected branch "main"/);
});

test("a checkout with no isolation and no work order is silent", async (t) => {
  const ws = workspace(t);
  ws.put(ws.plain, "src/a.ts");
  assert.equal(await report(bash(ws.plain, "node x.mjs"), ws.plain), null);
});

test("while swarm.dispatch is on, a main-session shell write outside the controller paths is reported, and a subagent's is not", async (t) => {
  const ws = workspace(t);
  writeFileSync(path.join(ws.plain, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {} } }));
  ws.put(ws.plain, "src/a.ts");
  ws.put(ws.plain, "docs/b.md");
  const call = bash(ws.plain, "sed -i 's/a/b/' src/a.ts");
  const output = await report(call, ws.plain);
  assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
  const text = contextOf(output);
  assert.match(text, /src\/a\.ts: outside the controller paths \(docs\/\*\*, /);
  assert.doesNotMatch(text, /docs\/b\.md/);
  assert.match(text, /dispatch an implementer/i);
  assert.doesNotMatch(text, /work order|orchestrator/);
  assert.equal(await report({ ...call, agent_id: "agent-1" }, ws.plain), null);
  assert.equal(await report(bash(ws.plain, "cat src/a.ts"), ws.plain), null);
});

test("with swarm.dispatch off, a shell write breaks no controller rule", async (t) => {
  const ws = workspace(t);
  writeFileSync(path.join(ws.plain, "qc.config.json"), JSON.stringify({ swarm: {} }));
  ws.put(ws.plain, "src/a.ts");
  assert.equal(await report(bash(ws.plain, "sed -i 's/a/b/' src/a.ts"), ws.plain), null);
});

test("porcelain output names each changed path, and both sides of a rename", () => {
  const status = [" M src/a.ts", "?? docs/new file.md", "R  lib/new.ts", "lib/old.ts", ""].join("\u0000");
  assert.deepEqual(changedPaths(status), ["src/a.ts", "docs/new file.md", "lib/new.ts", "lib/old.ts"]);
});

test("a --work-tree directory is a checkout the command could have changed", async (t) => {
  const ws = workspace(t);
  ws.put(ws.linked, "docs/b.md");
  const slash = (dir) => dir.replaceAll("\\", "/");
  const output = await report(bash(ws.outside, `git --work-tree=${slash(ws.linked)} checkout -- docs`), ws.linked);
  assert.match(contextOf(output), /docs\/b\.md: outside the work order's declared paths/);
});

test("a git dir with no work tree is reported as unresolved, not dropped", async (t) => {
  const ws = workspace(t);
  const slash = (dir) => dir.replaceAll("\\", "/");
  const text = contextOf(await report(bash(ws.outside, `git --git-dir=${slash(ws.primary)}/.git checkout main`), ws.linked));
  assert.match(text, /git directory with no work tree/);
  assert.ok(text.includes(`${slash(ws.primary)}/.git`), text);
  assert.match(text, /cannot tell which checkout/);
  const withTree = await report(bash(ws.outside, `git --git-dir=${slash(ws.primary)}/.git --work-tree=${slash(ws.outside)} checkout main`), ws.linked);
  assert.doesNotMatch(contextOf(withTree), /git directory with no work tree/);
});
