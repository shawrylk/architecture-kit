import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaults } from "../config.mjs";
import { branchNameRefusal, runWorkOrderCheck } from "./work-order-guard.mjs";

test("a branch names its issue: feat/340-roles passes and feat/back-action fails", () => {
  assert.equal(branchNameRefusal("feat/340-roles", defaults.branches), null);
  assert.match(branchNameRefusal("feat/back-action", defaults.branches), /names no issue/);
  assert.match(branchNameRefusal("Feat/340-roles", defaults.branches), /names no issue/);
});

test("main, a release branch and a detached HEAD pass, and a null pattern switches the rule off", () => {
  for (const branch of ["main", "master", "release/1.2", ""]) assert.equal(branchNameRefusal(branch, defaults.branches), null, branch);
  assert.equal(branchNameRefusal("feat/back-action", { ...defaults.branches, pattern: null }), null);
});

test("qc work-order-check refuses a commit on a branch that names no issue", async (t) => {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-branch-name-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "feat/back-action");
  writeFileSync(path.join(root, "qc.config.json"), "{}");
  t.mock.method(console, "error", () => {});
  assert.equal(await runWorkOrderCheck(root), 1);
  git("checkout", "-q", "-b", "feat/340-roles");
  assert.equal(await runWorkOrderCheck(root), 0);
});
