import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const qc = fileURLToPath(new URL("./qc.mjs", import.meta.url));

test("help describes the Codex limit expiry time", () => {
  const run = spawnSync(process.execPath, [qc, "help"], { encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /qc codex status[^\n]*with the expiry time and its source/);
});

function fixture(t, contents) {
  const root = mkdtempSync(path.join(tmpdir(), "qc-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "qc.config.json"), contents);
  return root;
}

test("an invalid integrate key prints one config error across commands", (t) => {
  const root = fixture(t, JSON.stringify({ integrate: { ciEvery: 0 } }));
  for (const command of ["config", "check", "lint", "typecheck", "e2e"]) {
    const run = spawnSync(process.execPath, [qc, command], { cwd: root, encoding: "utf8" });
    assert.equal(run.status, 1, command);
    assert.equal(run.stdout, "", command);
    assert.equal(run.stderr, "qc: invalid qc.config.json: integrate.ciEvery must be a positive integer\n", command);
    assert.doesNotMatch(run.stderr, /^\s+at /m, command);
  }
});

test("a JSON syntax error keeps its stack trace", (t) => {
  const root = fixture(t, "{");
  const run = spawnSync(process.execPath, [qc, "config"], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /SyntaxError:/);
  assert.match(run.stderr, /^\s+at /m);
  assert.doesNotMatch(run.stderr, /qc: invalid qc\.config\.json:/);
});

test("an error after loading config keeps its stack trace", (t) => {
  const root = fixture(t, "{}");
  const run = spawnSync(process.execPath, [qc, "check", "--files-from", "missing-files"], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /ENOENT/);
  assert.match(run.stderr, /^\s+at /m);
  assert.doesNotMatch(run.stderr, /qc: invalid qc\.config\.json:/);
});
