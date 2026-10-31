import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaults, requiredHooks } from "../config.mjs";
import { hookDrift } from "./git-hooks.mjs";

const TEMPLATES = fileURLToPath(new URL("../../templates/githooks/", import.meta.url));
const REQUIRED = { "pre-commit": ["qc work-order-check"], "pre-push": ["qc check"] };

test("pre-push reruns each pushed branch before qc check and stops on failure", (t) => {
  const r = repo(t);
  const script = readFileSync(path.join(TEMPLATES, "pre-push"), "utf8");
  const bin = path.join(r.root, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "npx"), '#!/bin/sh\necho "$*" >> "$CI_CALLS"\ncase "$*" in *ci-failures*) exit "${CI_RERUN_STATUS:-0}";; esac\n', { mode: 0o755 });
  const hook = path.join(r.root, "pre-push");
  writeFileSync(hook, script);
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  const calls = path.join(r.root, "calls.txt");
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CI_CALLS: calls, CI_RERUN_STATUS: "9" };
  const input = `refs/heads/feat/ci ${"a".repeat(40)} refs/heads/feat/ci ${"0".repeat(40)}\n`;
  const failed = spawnSync(bash, [hook], { cwd: r.root, env, input, encoding: "utf8" });
  assert.equal(failed.status, 9, failed.stderr);
  assert.match(readFileSync(calls, "utf8"), /qc ci-failures --rerun --branch feat\/ci/);
  assert.doesNotMatch(readFileSync(calls, "utf8"), /qc check/);
  writeFileSync(calls, "");
  const passed = spawnSync(bash, [hook], { cwd: r.root, env: { ...env, CI_RERUN_STATUS: "0" }, input, encoding: "utf8" });
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(readFileSync(calls, "utf8"), /ci-failures[\s\S]*qc check/);
});

function repo(t) {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-git-hooks-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "pipe" });
  const globalConfig = process.env.GIT_CONFIG_GLOBAL;
  const fixtureConfig = path.join(root, ".git", "fixture-global-config");
  writeFileSync(fixtureConfig, "");
  process.env.GIT_CONFIG_GLOBAL = fixtureConfig;
  t.after(() => { if (globalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = globalConfig; });
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

test("a pre-commit that never calls qc work-order-check fails, as example-app's did", (t) => {
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

const withConventional = (conventional) => ({ ...defaults, commitMessage: { ...defaults.commitMessage, conventional } });

function strictFolder(t, names) {
  const r = repo(t);
  mkdirSync(path.join(r.root, ".githooks"));
  for (const name of names) copyFileSync(path.join(TEMPLATES, name), path.join(r.root, ".githooks", name));
  return r;
}

test("conventional on and no commit-msg hook fails hooks (strict folder)", (t) => {
  const r = strictFolder(t, ["pre-commit", "pre-push"]);
  const { problems } = hookDrift(r.root, requiredHooks(withConventional(true)));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].path, ".githooks/commit-msg");
  assert.match(problems[0].detail, /commit-msg is missing/);
});

test("conventional on and the template commit-msg hook passes", (t) => {
  const r = strictFolder(t, ["pre-commit", "pre-push", "commit-msg"]);
  assert.deepEqual(hookDrift(r.root, requiredHooks(withConventional(true))).problems, []);
});

test("conventional false and no commit-msg hook passes", (t) => {
  const r = strictFolder(t, ["pre-commit", "pre-push"]);
  assert.deepEqual(hookDrift(r.root, requiredHooks(withConventional(false))).problems, []);
});
