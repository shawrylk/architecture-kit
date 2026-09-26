import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hookDrift } from "./git-hooks.mjs";

const TEMPLATES = fileURLToPath(new URL("../../templates/githooks/", import.meta.url));
const REQUIRED = { "pre-commit": ["qc work-order-check"], "pre-push": ["qc check"] };

function repo(t) {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-git-hooks-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "pipe" });
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  const hook = (dir, name, text) => {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, dir, name), text);
  };
  return { root, git, hook };
}


test("the kit's template hooks, installed through core.hooksPath, carry every required step", (t) => {
  const r = repo(t);
  mkdirSync(path.join(r.root, "hooks-here"));
  for (const name of ["pre-commit", "pre-push", "commit-msg"]) copyFileSync(path.join(TEMPLATES, name), path.join(r.root, "hooks-here", name));
  r.git("config", "core.hooksPath", "hooks-here");
  assert.deepEqual(hookDrift(r.root, REQUIRED).problems, []);
});

test("a pre-commit that never calls qc work-order-check fails, as quality-control-mono's did", (t) => {
  const r = repo(t);
  r.hook(".githooks", "pre-commit", "#!/usr/bin/env bash\nset -euo pipefail\nnpx eslint $STAGED --max-warnings 0\n");
  r.hook(".githooks", "pre-push", "#!/usr/bin/env bash\nnpx qc check\n");
  r.git("config", "core.hooksPath", ".githooks");
  const found = hookDrift(r.root, REQUIRED);
  assert.equal(found.problems.length, 1);
  assert.equal(found.problems[0].rule, "hook-drift");
  assert.match(found.problems[0].detail, /pre-commit never calls `qc work-order-check`/);
});

test("a call in a comment is no call, and a missing hook in a tracked folder fails", (t) => {
  const r = repo(t);
  r.hook(".githooks", "pre-commit", "#!/usr/bin/env bash\n# npx qc work-order-check\n");
  const found = hookDrift(r.root, REQUIRED);
  assert.deepEqual(found.problems.map((problem) => problem.detail.split(" ").slice(0, 2).join(" ")), ["pre-commit never", "pre-push is"]);
});

test("with no core.hooksPath, the tracked .githooks folder is read, since every clone installs it", (t) => {
  const r = repo(t);
  r.hook(".githooks", "pre-commit", "npx qc work-order-check\n");
  r.hook(".githooks", "pre-push", "npx qc check\n");
  assert.deepEqual(hookDrift(r.root, REQUIRED).problems, []);
});

test("with neither, git's own hooks folder is read, and a hook not installed there is a note", (t) => {
  const r = repo(t);
  r.hook(".git/hooks", "pre-push", "#!/bin/sh\nexit 0\n");
  const found = hookDrift(r.root, REQUIRED);
  assert.equal(found.problems.length, 1);
  assert.match(found.problems[0].detail, /pre-push never calls `qc check`/);
  assert.match(found.notes.join("\n"), /pre-commit is not installed/);
});

test("an emptied entry requires nothing of that hook", (t) => {
  const r = repo(t);
  r.hook(".githooks", "pre-commit", "npx qc work-order-check\n");
  assert.deepEqual(hookDrift(r.root, { ...REQUIRED, "pre-push": [] }).problems, []);
});

test("qc doctor fails on hook drift, and passes the kit's template", async (t) => {
  const { runDoctor } = await import("./doctor.mjs");
  const r = repo(t);
  r.hook(".githooks", "pre-commit", "npx eslint .\n");
  r.hook(".githooks", "pre-push", "npx qc check\n");
  const quiet = t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  assert.equal(await runDoctor({ root: r.root, hooks: { required: REQUIRED } }), 1);
  assert.match(quiet.mock.calls.map((call) => call.arguments[0]).join("\n"), /pre-commit never calls `qc work-order-check`/);
  copyFileSync(path.join(TEMPLATES, "pre-commit"), path.join(r.root, ".githooks", "pre-commit"));
  assert.equal(await runDoctor({ root: r.root, hooks: { required: REQUIRED } }), 0);
});
