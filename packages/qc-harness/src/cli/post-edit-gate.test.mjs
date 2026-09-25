import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "hooks", "post-edit-gate.sh");

/** A session's project checkout, one linked worktree, a checkout with no config, a folder in none, and a qc CLI that records where it ran. */
function workspace() {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-post-edit-")));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  const project = path.join(base, "project");
  const linked = path.join(base, "linked");
  const plain = path.join(base, "plain");
  const outside = path.join(base, "outside", "features", "x");
  for (const dir of [project, plain, outside]) mkdirSync(dir, { recursive: true });
  git(project, "init", "-q", "-b", "main");
  writeFileSync(path.join(project, "qc.config.json"), "{}");
  git(project, "add", ".");
  git(project, "-c", "user.name=qc", "-c", "user.email=qc@example.com", "commit", "-q", "-m", "init");
  git(project, "worktree", "add", "-q", linked, "-b", "feat/work-order");
  git(plain, "init", "-q", "-b", "main");

  const log = path.join(base, "qc-ran.log");
  const cli = path.join(base, "plugin", "packages", "qc-harness", "src", "cli");
  mkdirSync(cli, { recursive: true });
  writeFileSync(
    path.join(cli, "qc.mjs"),
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, process.cwd() + String.fromCharCode(10));\nprocess.exit(1);\n`,
  );
  const ranIn = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((dir) => realpathSync.native(dir)) : []);
  return { project, linked, plain, outside, pluginRoot: path.join(base, "plugin"), ranIn, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function runHook(ws, file) {
  const featureFile = path.join(file, "features", "tasks", "index.ts");
  mkdirSync(path.dirname(featureFile), { recursive: true });
  writeFileSync(featureFile, "export {};\n");
  return spawnSync("bash", [HOOK], {
    input: JSON.stringify({ tool_input: { file_path: featureFile } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: ws.project, CLAUDE_PLUGIN_ROOT: ws.pluginRoot },
    encoding: "utf8",
  }).status;
}

test("a feature file in no git checkout runs no gate, even when the session's project has adopted the kit", (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  assert.equal(runHook(ws, ws.outside), 0);
  assert.deepEqual(ws.ranIn(), []);
});

test("a feature file in a linked worktree is checked from that worktree, not the session's project", (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  assert.equal(runHook(ws, path.join(ws.linked, "backend", "src")), 2);
  assert.deepEqual(ws.ranIn(), [ws.linked]);
});

test("a feature file in a checkout with no qc.config.json runs no gate", (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  assert.equal(runHook(ws, path.join(ws.plain, "backend", "src")), 0);
  assert.deepEqual(ws.ranIn(), []);
});

test("a feature file in the session's own project is checked from the project", (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  assert.equal(runHook(ws, path.join(ws.project, "backend", "src")), 2);
  assert.deepEqual(ws.ranIn(), [ws.project]);
});
