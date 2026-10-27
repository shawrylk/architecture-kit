import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { skillActivationOf } from "./run.mjs";
import * as runner from "./run.mjs";
import { spawnSync } from "node:child_process";

test("skill activation requires an assistant Skill call naming the exact expected skill", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-skill-eval-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, "run.jsonl");
  const expected = "architecture:writing-plain-english";
  const event = (name, skill, type = "assistant") => ({ type, message: {
    content: [{ type: "tool_use", name, input: { skill } }],
  } });
  assert.equal(skillActivationOf(transcript, expected), false);
  for (const record of [event("Read", expected), event("Skill", "other"), event("Skill", expected, "user"),
    event("Skill", `${expected}-extra`), { type: "assistant", message: { content: expected } }]) {
    writeFileSync(transcript, `broken\n${JSON.stringify(record)}\n`);
    assert.equal(skillActivationOf(transcript, expected), false);
  }
  writeFileSync(transcript, `broken\n${JSON.stringify(event("Skill", expected))}\n`);
  assert.equal(skillActivationOf(transcript, expected), true);
});


test("fixture setup commits through an empty local hook folder before it binds agent hooks", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-eval-hooks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hooks = path.join(dir, "global-hooks");
  mkdirSync(hooks);
  const sentinel = path.join(dir, "global-hook-ran");
  for (const hook of ["pre-commit", "commit-msg"]) {
    writeFileSync(path.join(hooks, hook), `#!/bin/sh\necho invoked > '${sentinel.replaceAll("\\", "/")}'\nexit 1\n`, { mode: 0o755 });
  }
  const config = path.join(dir, "global-config");
  writeFileSync(config, `[core]\n  hooksPath = "${hooks.replaceAll("\\", "/")}"\n`);
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  t.after(() => { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; });
  const deps = path.join(dir, "deps");
  mkdirSync(path.join(deps, "node_modules/.bin"), { recursive: true });
  assert.equal(typeof runner.prepare, "function");
  const { repo } = runner.prepare(path.join(dir, "run"), deps);
  const initial = spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: repo, encoding: "utf8" });
  assert.equal(initial.status, 0, initial.stderr);
  assert.equal(initial.stdout.trim(), "1");
  assert.equal(existsSync(sentinel), false);
  const localConfig = readFileSync(path.join(repo, ".git/config"), "utf8");
  assert.match(localConfig, /hooksPath = \.git\/hooks/);
});

test("run fails when a commit hook refuses the fixture commit", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-eval-commit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-q");
  const hooks = path.join(dir, "hooks");
  mkdirSync(hooks);
  writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\necho fixture-refused >&2\nexit 1\n", { mode: 0o755 });
  git("config", "core.hooksPath", hooks.replaceAll("\\", "/"));
  assert.equal(typeof runner.run, "function");
  assert.throws(() => runner.run("git", ["-c", "user.name=eval", "-c", "user.email=eval@example.com", "commit", "--allow-empty", "-qm", "chore: fixture"], dir), /fixture-refused/);
});

test("the package test script runs the offline eval unit tests", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../packages/qc-harness/package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts.test, /node --test.*\.\.\/\.\.\/evals\/agents\/run\.test\.mjs/);
});
