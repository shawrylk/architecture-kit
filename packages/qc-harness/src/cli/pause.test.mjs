import { strict as assert } from "node:assert";
import childProcess, { execFileSync, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { pauseRefusal, pauseState, runPause, runResume } from "./pause.mjs";

const QC = fileURLToPath(new URL("./qc.mjs", import.meta.url));

function repository(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-pause-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "repo");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "init"]);
  return { dir, root };
}

test("pause and resume share the common git folder across worktrees and nested folders", (t) => {
  const { dir, root } = repository(t);
  const worktree = path.join(dir, "linked");
  execFileSync("git", ["-C", root, "worktree", "add", "-qb", "linked", worktree]);
  const nested = path.join(worktree, "nested");
  mkdirSync(nested);
  const lines = [];
  const say = (line) => lines.push(line);
  assert.equal(pauseState(nested), null);
  assert.equal(runPause(root, ["--reason", "operator investigation"], { say }), 0);
  assert.equal(readFileSync(path.join(root, ".git", "qc", "pause"), "utf8").trim(), "operator investigation");
  assert.equal(pauseState(nested), "operator investigation");
  assert.match(pauseRefusal(nested), /operator investigation.*qc resume/);
  assert.equal(pauseRefusal(nested), "An operator paused the kit: operator investigation. Wait for the operator to run `qc resume`.");
  assert.equal(runPause(nested, ["--status"], { say }), 0);
  assert.match(lines.at(-1), /paused.*operator investigation/);
  assert.equal(runResume(nested, [], { say }), 0);
  assert.equal(pauseRefusal(root), null);
  assert.equal(runResume(root, [], { say }), 0);
  assert.equal(runPause(root, ["--status"], { say }), 0);
  assert.match(lines.at(-1), /running/);
});

test("the CLI pauses and resumes even when the repository config is invalid", (t) => {
  const { root } = repository(t);
  writeFileSync(path.join(root, "qc.config.json"), "invalid JSON");
  const call = (...args) => spawnSync(process.execPath, [QC, ...args], { cwd: root, encoding: "utf8" });
  assert.equal(call("pause").status, 0);
  assert.match(call("pause", "--status").stdout, /paused.*operator pause/);
  assert.equal(call("resume").status, 0);
  assert.match(call("pause", "--status").stdout, /running/);
  assert.equal(existsSync(path.join(root, ".git", "qc", "pause")), false);
});

test("invalid pause and resume arguments leave the pause unchanged", (t) => {
  const { root } = repository(t);
  const say = () => {};
  for (const argv of [["--reason"], ["--unknown"], ["--status", "--reason", "x"], ["--reason", " "]]) {
    assert.equal(runPause(root, argv, { say }), 2);
    assert.equal(pauseState(root), null);
  }
  assert.equal(runPause(root, ["--reason", "keep"], { say }), 0);
  assert.equal(runResume(root, ["--unknown"], { say }), 2);
  assert.equal(pauseState(root), "keep");
});

test("pause read errors refuse operation instead of treating the repository as running", (t) => {
  const { root } = repository(t);
  mkdirSync(path.join(root, ".git", "qc", "pause"), { recursive: true });
  assert.throws(() => pauseState(root));
});

test("the pause git lookup has a bounded timeout", (t) => {
  const { root } = repository(t);
  const original = childProcess.execFileSync;
  const lookup = t.mock.method(childProcess, "execFileSync", (command, args, options) => {
    assert.equal(command, "git");
    assert.deepEqual(args, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    assert.ok(options.timeout > 0 && options.timeout <= 5000, "the git lookup needs a timeout within the hook budget");
    return original(command, args, options);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(pauseState(root), null);
  } finally {
    lookup.mock.restore();
    syncBuiltinESMExports();
  }
});
