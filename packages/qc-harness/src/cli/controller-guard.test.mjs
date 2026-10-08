import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decide, isControllerPath } from "./controller-guard.mjs";

const HOOK = fileURLToPath(new URL("./controller-guard.mjs", import.meta.url));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

/** A checkout with the checks on and a linked worktree, another repository, and a folder outside any checkout. */
function workspace(t, dispatchConfig = { swarm: { dispatch: {} } }) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-controller-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const main = path.join(base, "main");
  const other = path.join(base, "other");
  git(base, "init", "-q", "-b", "main", main);
  git(base, "init", "-q", "-b", "main", other);
  for (const [key, value] of [["user.name", "qc"], ["user.email", "qc@example.com"], ["commit.gpgsign", "false"]]) {
    git(main, "config", key, value);
  }
  writeFileSync(path.join(main, "a.txt"), "a\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  writeFileSync(path.join(main, "qc.config.json"), JSON.stringify(dispatchConfig));
  const linked = path.join(base, "linked");
  git(main, "worktree", "add", "-q", "-b", "feat/1-x", linked);
  const scratch = path.join(base, "scratch");
  mkdirSync(scratch);
  return { main, other, linked, scratch };
}

const edit = (cwd, file_path, tool_name = "Edit", extra = {}) => ({
  session_id: "s",
  cwd,
  hook_event_name: "PreToolUse",
  tool_name,
  tool_input: tool_name === "NotebookEdit" ? { notebook_path: file_path } : { file_path },
  ...extra,
});
const denied = (output) => output?.hookSpecificOutput?.permissionDecisionReason ?? null;

test("with swarm.dispatch off, the main session edits anything", (t) => {
  const ws = workspace(t, { swarm: {} });
  assert.equal(decide(edit(ws.main, path.join(ws.main, "src", "a.ts"))), null);
});

test("a subagent's edit is left alone", (t) => {
  const ws = workspace(t);
  assert.equal(decide(edit(ws.main, path.join(ws.main, "src", "a.ts"), "Write", { agent_id: "agent-1" })), null);
});

test("the main session's edit of code in the checkout, or in its worktree, is refused", (t) => {
  const ws = workspace(t);
  for (const [file, rel] of [
    [path.join(ws.main, "src", "a.ts"), "src/a.ts"],
    [path.join(ws.main, "src", "notes.md"), "src/notes.md"],
    [path.join(ws.linked, "src", "a.ts"), "src/a.ts"],
  ]) {
    assert.match(denied(decide(edit(ws.main, file))) ?? "", new RegExp(`${rel.replace(".", "\\.")} is outside them`), file);
  }
  assert.match(denied(decide(edit(ws.main, path.join(ws.main, "nb.ipynb"), "NotebookEdit"))) ?? "", /nb\.ipynb/);
});

test("the controller's own paths, a path outside the checkout, and another repository pass", (t) => {
  const ws = workspace(t);
  for (const file of [
    path.join(ws.main, "docs", "plan.md"),
    path.join(ws.main, "README.md"),
    path.join(ws.main, "qc.config.json"),
    path.join(ws.main, ".claude", "settings.json"),
    path.join(ws.main, "pkg", ".claude", "rules", "a.md"),
    path.join(ws.linked, "docs", "a.md"),
    path.join(ws.scratch, "brief.md"),
    path.join(ws.other, "src", "a.ts"),
  ]) {
    assert.equal(decide(edit(ws.main, file, "Write")), null, file);
  }
});

test("a Windows path with either separator is judged the same", (t) => {
  const ws = workspace(t);
  const file = path.join(ws.main, "src", "a.ts");
  assert.ok(denied(decide(edit(ws.main, file.replaceAll("\\", "/")))));
  if (process.platform === "win32") assert.ok(denied(decide(edit(ws.main, file.replaceAll("/", "\\")))));
});

test("a repository replaces the controller paths", (t) => {
  const ws = workspace(t, { swarm: { dispatch: {}, review: { controllerPaths: ["src/**"] } } });
  assert.equal(decide(edit(ws.main, path.join(ws.main, "src", "a.ts"))), null);
  assert.ok(denied(decide(edit(ws.main, path.join(ws.main, "docs", "a.md")))));
});

test("a config error is reported as context, never as a refusal", (t) => {
  const ws = workspace(t, { swarm: { dispatch: "on" } });
  const output = decide(edit(ws.main, path.join(ws.main, "src", "a.ts")));
  assert.match(output?.hookSpecificOutput?.additionalContext ?? "", /Controller guard is off/);
});

test("the hook process prints the deny", (t) => {
  const ws = workspace(t);
  const result = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(edit(ws.main, path.join(ws.main, "src", "a.ts"))), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("Windows reads a path with no regard to case, so the other systems do not", (t) => {
  const ws = workspace(t);
  const globs = ["docs/**", "*.md", "qc.config.json", "**/.claude/**"];
  for (const rel of ["Docs/plan.md", "README.MD", "QC.config.json", "pkg/.CLAUDE/a.md"]) {
    assert.equal(isControllerPath(rel, globs, "win32"), true, rel);
    assert.equal(isControllerPath(rel, globs, "linux"), false, rel);
    assert.equal(decide(edit(ws.main, path.join(ws.main, ...rel.split("/")), "Write"), "win32"), null, rel);
    assert.ok(denied(decide(edit(ws.main, path.join(ws.main, ...rel.split("/")), "Write"), "linux")), rel);
  }
  assert.equal(isControllerPath("src/A.ts", globs, "win32"), false);
});

/** The workspace, with `origin/main` at the first commit so the linked worktree's branch has a base. */
function laneWorkspace(t, config) {
  const ws = workspace(t, config);
  git(ws.main, "update-ref", "refs/remotes/origin/main", "main");
  return ws;
}

const small = { old_string: "a", new_string: "b" };

test("a small edit on a branch passes through the direct lane, with a note of its size", (t) => {
  const ws = laneWorkspace(t);
  const output = decide(edit(ws.main, path.join(ws.linked, "src", "a.ts"), "Edit", { tool_input: { file_path: path.join(ws.linked, "src", "a.ts"), ...small } }));
  assert.equal(denied(output), null);
  assert.match(output?.hookSpecificOutput?.additionalContext ?? "", /Direct lane: with this edit the branch changes 2 of 20 lines in 1 of 2 files/);
});

test("an edit that leaves the direct lane is refused with the reason", (t) => {
  const ws = laneWorkspace(t);
  const big = { old_string: "a\n".repeat(11), new_string: "b\n".repeat(11) };
  const linked = path.join(ws.linked, "src", "a.ts");
  assert.match(denied(decide(edit(ws.main, linked, "Edit", { tool_input: { file_path: linked, ...big } }))) ?? "", /does not apply: the branch changes 22 of 20 lines/);
  const onMain = path.join(ws.main, "src", "a.ts");
  assert.match(denied(decide(edit(ws.main, onMain, "Edit", { tool_input: { file_path: onMain, ...small } }))) ?? "", /main is a protected branch/);
});

test("with swarm.direct false, the refusal is the controller's alone", (t) => {
  const ws = laneWorkspace(t, { swarm: { dispatch: {}, direct: false } });
  const linked = path.join(ws.linked, "src", "a.ts");
  assert.equal(
    denied(decide(edit(ws.main, linked, "Edit", { tool_input: { file_path: linked, ...small } }))),
    "Controller guard: while swarm.dispatch is on, the main session edits only swarm.review.controllerPaths " +
      "(docs/**, *.md, qc.config.json, **/.claude/**), and src/a.ts is outside them. Write a brief and dispatch an implementer for this change. " +
      "For a path the controller owns, add its glob to swarm.review.controllerPaths in qc.config.json.",
  );
});
