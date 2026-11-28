import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../../plugins/architecture-extras/", import.meta.url));

test("extras hooks run from a copied plugin and pass input, output and exit status to the installed harness", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-extras-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const installed = path.join(root, "plugin");
  cpSync(source, installed, { recursive: true });
  const project = path.join(root, "project");
  const harness = path.join(project, "node_modules", "architecture-harness");
  mkdirSync(path.join(harness, "src", "cli"), { recursive: true });
  writeFileSync(path.join(harness, "package.json"), JSON.stringify({ name: "architecture-harness", type: "module", exports: { "./package.json": "./package.json" } }));
  writeFileSync(path.join(harness, "src", "cli", "checkpoint.mjs"), 'process.stdin.pipe(process.stdout); process.stdin.on("end", () => { console.error("hook error"); process.exitCode = 2; });');
  const result = spawnSync(process.execPath, [path.join(installed, "hooks", "run.mjs"), "checkpoint.mjs"], {
    cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: project }, input: '{"session_id":"s"}', encoding: "utf8",
  });
  assert.equal(result.stdout, '{"session_id":"s"}');
  assert.equal(result.stderr.trim(), "hook error");
  assert.equal(result.status, 2);
  const unknown = spawnSync(process.execPath, [path.join(installed, "hooks", "run.mjs"), "../qc.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown extras hook/);
});
