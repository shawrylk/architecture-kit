import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { expandHome, parseApiList, runGh, runGhResult } from "./gh-run.mjs";

test("runGh captures a failed-run log larger than one MB", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "qc-gh-large-"));
  try {
    copyFileSync(process.execPath, path.join(cwd, process.platform === "win32" ? "gh.exe" : "gh"));
    const result = runGhResult(["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"], { cwd, env: { PATH: cwd } });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.length, 2 * 1024 * 1024);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("parseApiList combines every page and rejects incomplete or malformed pages", () => {
  assert.deepEqual(parseApiList('[{"check_runs":[1]},{"check_runs":[2]}]', "check_runs"), [1, 2]);
  assert.deepEqual(parseApiList('{"workflow_runs":[]}', "workflow_runs"), []);
  for (const text of [null, "not JSON", "{}", '[{"check_runs":[]},{}]']) assert.equal(parseApiList(text, "check_runs"), null);
});

test("expandHome expands a leading ~ the way the shell would, and leaves every other value", () => {
  assert.deepEqual(expandHome({ GH_CONFIG_DIR: "~/.config/gh-personal", GH_HOST: "ghe.example.com" }), {
    GH_CONFIG_DIR: path.join(os.homedir(), "/.config/gh-personal"),
    GH_HOST: "ghe.example.com",
  });
  assert.deepEqual(expandHome({ A: "~\\.config\\gh", B: "~" }), {
    A: path.join(os.homedir(), "\\.config\\gh"),
    B: os.homedir(),
  });
  assert.deepEqual(expandHome({ A: "~other/x", B: "C:/gh" }), { A: "~other/x", B: "C:/gh" });
  assert.deepEqual(expandHome(undefined), {});
});

test("runGh answers null when gh fails or is missing", () => {
  assert.equal(runGh(["no-such-command-for-qc"]), null);
});

test("runGhResult returns stdout and stderr with the exit status", (t) => {
  const success = runGhResult(["--version"]);
  if (success.error?.code === "ENOENT") return t.skip("gh is not on PATH");
  assert.equal(success.status, 0);
  assert.match(success.stdout, /gh version/);
  assert.equal(success.stderr, "");
  const failure = runGhResult(["no-such-command-for-qc"]);
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /unknown command/);
});

test("runGhResult preserves spawn errors", () => {
  const result = runGhResult(["--version"], { cwd: path.join(os.tmpdir(), "qc-gh-missing", "missing") });
  assert.equal(result.status, null);
  assert.equal(result.error.code, "ENOENT");
});

test("the real gh test skips with a reason when gh is absent from PATH", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "qc-gh-absent-"));
  try {
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern=^runGhResult returns stdout", import.meta.filename], {
      encoding: "utf8", env: { ...process.env, PATH: cwd, NODE_TEST_CONTEXT: undefined },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# SKIP gh is not on PATH/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
