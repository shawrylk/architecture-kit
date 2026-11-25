import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const qc = fileURLToPath(new URL("./qc.mjs", import.meta.url));

test("codex-stop-hook CLI routes only explicit leader Stop JSON", (t) => {
  const help = spawnSync(process.execPath, [qc, "help"], { encoding: "utf8" });
  assert.match(help.stdout, /qc codex-stop-hook --role leader/);
  assert.match(help.stdout, /SubagentStop unsupported.*no registration/);
  for (const [args, input] of [[[], "{}"], [["--role", "leader"], "{"], [["--role", "worker"], "{}"]]) {
    const result = spawnSync(process.execPath, [qc, "codex-stop-hook", ...args], { input, encoding: "utf8" });
    assert.equal(result.status, 2); assert.equal(result.stdout, "");
    assert.match(result.stderr, /Codex Stop/);
  }
  const cwd = fixture(t, "{}"); rmSync(path.join(cwd, "qc.config.json"));
  const input = JSON.stringify({ hook_event_name: "Stop", cwd, session_id: "stable", turn_id: "turn", stop_hook_active: false });
  const result = spawnSync(process.execPath, [qc, "codex-stop-hook", "--role", "leader"], { input, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), {});
});

test("codex-hook CLI advertises its pinned boundary and emits native denial before action", () => {
  const help = spawnSync(process.execPath, [qc, "help"], { encoding: "utf8" });
  assert.match(help.stdout, /qc codex-hook --role <role>/);
  assert.match(help.stdout, /0\.172\.0.*Bash.*PreToolUse.*PostToolUse/);
  const input = JSON.stringify({ session_id: "stable", turn_id: "turn", tool_use_id: "call", cwd: process.cwd(),
    hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git -c core.hooksPath=/dev/null status" } });
  const result = spawnSync(process.execPath, [qc, "codex-hook", "--role", "leader"], { input, encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
  const invalid = spawnSync(process.execPath, [qc, "codex-hook", "--role", "leader", "--extra"], { input, encoding: "utf8" });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /usage: qc codex-hook/);
});

test("comment-watch help requires explicit poll, checkout, and session inputs", (t) => {
  const root = fixture(t, "{}");
  const run = (args) => spawnSync(process.execPath, [qc, ...args], { cwd: root, encoding: "utf8" });
  const help = run(["help"]);
  assert.match(help.stdout, /qc comment-watch --poll --cwd <dir> --session <id>/);
  assert.match(help.stdout, /same session ledger.*without acknowledging/);
  for (const args of [[], ["--poll"], ["--cwd", root, "--session", "a"],
    ["--poll", "--cwd", root], ["--poll", "--session", "a"],
    ["--poll", "--cwd", root, "--session", " "],
    ["--poll", "--cwd", root, "--session", "a", "--poll"],
    ["--poll", "--cwd", root, "--session", "a", "--unknown"],
    ["--poll", "--cwd", path.join(root, "missing"), "--session", "a"],
    ["--poll", "--cwd", path.join(root, "qc.config.json"), "--session", "a"]]) {
    const result = run(["comment-watch", ...args]);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /usage: qc comment-watch/);
  }
});

test("help describes full checks, previews, and readiness", () => {
  const run = spawnSync(process.execPath, [qc, "help"], { encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /qc check --full \[--os <linux\|windows>\]/);
  assert.match(run.stdout, /qc ci-preview \[--os <linux\|windows\|both>\]/);
  assert.match(run.stdout, /qc ready-check/);
});

test("help describes the operator pause commands and exit 5", () => {
  const run = spawnSync(process.execPath, [qc, "help"], { encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /qc pause \[--reason <text>\]/);
  assert.match(run.stdout, /qc resume/);
  assert.match(run.stdout, /exit 5.*paused/);
});

test("help describes the Codex limit expiry time", () => {
  const run = spawnSync(process.execPath, [qc, "help"], { encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /qc codex status[^\n]*with the expiry time and its source/);
});

test("overview and debt commands advertise usage and propagate exits", (t) => {
  const root = fixture(t, "{}");
  const run = (args) => spawnSync(process.execPath, [qc, ...args], { cwd: root, encoding: "utf8" });
  const help = run(["help"]);
  for (const command of ["qc overview", "qc debt file <report>", "qc debt due"]) assert.ok(help.stdout.includes(command));
  for (const args of [["overview", "extra"], ["debt"], ["debt", "file"], ["debt", "due", "extra"]]) assert.equal(run(args).status, 1);
  assert.equal(run(["debt", "due"]).status, 3);
  assert.equal(run(["debt", "file", "missing.md"]).status, 3);
});

function fixture(t, contents) {
  const root = mkdtempSync(path.join(tmpdir(), "qc-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
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

test("milestone help and dispatch expose dry-run and drop", (t) => {
  const help = spawnSync(process.execPath, [qc, "help"], { encoding: "utf8" });
  assert.match(help.stdout, /qc milestone.*--dry-run.*--drop/);
  const root = fixture(t, "{}");
  const result = spawnSync(process.execPath, [qc, "milestone", "--unknown"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /qc milestone/);
});

test("milestone names pass the commit-time branch check without widening issue branch patterns", async () => {
  const { branchNameRefusal } = await import("./work-order-guard.mjs");
  const settings = { pattern: "^[a-z]+/[0-9]+-", allow: ["main"] };
  assert.equal(branchNameRefusal("milestone/2026-11-23-1", settings), null);
  for (const branch of ["milestone/wrong", "milestone/2026-11-23-0", "feat/wrong"]) assert.match(branchNameRefusal(branch, settings) ?? "", /names no issue/);
});
