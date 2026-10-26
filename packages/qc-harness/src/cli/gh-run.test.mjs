import { strict as assert } from "node:assert";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { expandHome, runGh, runGhResult } from "./gh-run.mjs";

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

test("runGhResult returns stdout and stderr with the exit status", () => {
  const success = runGhResult(["--version"]);
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
