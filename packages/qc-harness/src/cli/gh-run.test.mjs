import { strict as assert } from "node:assert";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { expandHome, runGh } from "./gh-run.mjs";

test("expandHome expands a leading ~ the way the shell would, and leaves every other value", () => {
  assert.deepEqual(expandHome({ GH_CONFIG_DIR: "~/.config/gh-personal", GH_HOST: "ghe.example.com" }), {
    GH_CONFIG_DIR: path.join(os.homedir(), "/.config/gh-personal"),
    GH_HOST: "ghe.example.com",
  });
  assert.deepEqual(expandHome({ A: "~other/x", B: "C:/gh" }), { A: "~other/x", B: "C:/gh" });
  assert.deepEqual(expandHome(undefined), {});
});

test("runGh answers null when gh fails or is missing", () => {
  assert.equal(runGh(["no-such-command-for-qc"]), null);
});
