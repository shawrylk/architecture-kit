import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { branchMismatch, decide, denyOutput, globToRegExp, inSpecialGitOperation, isAllowed } from "./work-order-guard.mjs";

test("a path under a declared glob is allowed", () => {
  assert.equal(isAllowed("frontend/src/platform/ui/button.tsx", ["frontend/src/platform/**"]), true);
});

test("a path outside every declared glob is refused", () => {
  assert.equal(isAllowed("backend/src/main.ts", ["frontend/src/platform/**"]), false);
});

test("no declared paths means no restriction", () => {
  assert.equal(isAllowed("anything/at/all.ts", []), true);
});

test("a single star does not cross a directory boundary", () => {
  assert.equal(isAllowed(".github/workflows/nested/ci.yml", [".github/workflows/*.yml"]), false);
  assert.equal(isAllowed(".github/workflows/ci.yml", [".github/workflows/*.yml"]), true);
});

test("the deny reason names the file and the declared paths", () => {
  const output = denyOutput("backend/src/main.ts", ["frontend/src/platform/**"]);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /backend\/src\/main\.ts/);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /frontend\/src\/platform/);
});

test("globToRegExp escapes a regex metacharacter in a literal path segment", () => {
  assert.equal(globToRegExp("docs/a.b/**").test("docs/aXb/index.md"), false);
  assert.equal(globToRegExp("docs/a.b/**").test("docs/a.b/index.md"), true);
});

test("no declared branch means no restriction", () => {
  assert.equal(branchMismatch(undefined, "main"), null);
});

test("the current branch matching the declared one is not a mismatch", () => {
  assert.equal(branchMismatch("infra/5-reconcile", "infra/5-reconcile"), null);
});

test("a mismatch names both the declared branch and the current one", () => {
  const reason = branchMismatch("infra/5-reconcile", "main");
  assert.match(reason, /infra\/5-reconcile/);
  assert.match(reason, /main/);
});

test("detached HEAD is named explicitly, not left blank", () => {
  assert.match(branchMismatch("infra/5-reconcile", ""), /detached HEAD/);
});

test("a rebase or cherry-pick in progress is a special git operation", () => {
  const markers = new Set(["rebase-merge"]);
  assert.equal(inSpecialGitOperation("/repo/.git", (p) => markers.has(path.basename(p))), true);
});

test("an ordinary checkout is not a special git operation", () => {
  assert.equal(inSpecialGitOperation("/repo/.git", () => false), false);
});

test("the installed pre-commit hook checks the work order before its staged-file filter", () => {
  const templatePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "templates",
    "githooks",
    "pre-commit",
  );
  const lines = readFileSync(templatePath, "utf8").split("\n");
  const checkLine = lines.findIndex((line) => line.includes("qc work-order-check"));
  const filterLine = lines.findIndex((line) => line.includes("STAGED="));
  assert.notEqual(checkLine, -1, "pre-commit should call qc work-order-check");
  assert.notEqual(filterLine, -1, "pre-commit should still filter staged files by extension");
  assert.ok(checkLine < filterLine, "the branch check must run before the extension filter, or a .tf/.yml/.md commit skips it");
});

/** A primary checkout on main that requires worktree isolation, one linked worktree, and a folder in no checkout. */
function isolatedRepository() {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-guard-")));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  const primary = path.join(base, "primary");
  const linked = path.join(base, "linked");
  const outside = path.join(base, "outside");
  mkdirSync(primary);
  mkdirSync(outside);
  git(primary, "init", "-q", "-b", "main");
  writeFileSync(path.join(primary, "qc.config.json"), JSON.stringify({ swarm: { isolation: { require: "worktree" } } }));
  git(primary, "add", ".");
  git(primary, "-c", "user.name=qc", "-c", "user.email=qc@example.com", "commit", "-q", "-m", "init");
  git(primary, "worktree", "add", "-q", linked, "-b", "feat/work-order");
  return { primary, linked, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const editOf = (file) => ({ tool_input: { file_path: file }, session_id: "session-aaaa" });

test("an edit to a file in no git checkout is allowed, whatever branch the project is on", async (t) => {
  const repo = isolatedRepository();
  t.after(repo.cleanup);
  assert.equal(await decide(editOf(path.join(repo.outside, "memory", "note.md")), repo.primary), null);
});

test("an edit in a linked worktree on a work-order branch is judged by that worktree, not the project", async (t) => {
  const repo = isolatedRepository();
  t.after(repo.cleanup);
  assert.equal(await decide(editOf(path.join(repo.linked, "src", "new-folder", "file.ts")), repo.primary), null);
});

test("an edit in the primary checkout on a protected branch is still refused", async (t) => {
  const repo = isolatedRepository();
  t.after(repo.cleanup);
  const output = await decide(editOf(path.join(repo.primary, "src", "file.ts")), repo.primary);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /"main" is a protected branch/);
});

test("the primary checkout is refused even when the session opened the linked worktree", async (t) => {
  const repo = isolatedRepository();
  t.after(repo.cleanup);
  const output = await decide(editOf(path.join(repo.primary, "src", "file.ts")), repo.linked);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /"main" is a protected branch/);
});
