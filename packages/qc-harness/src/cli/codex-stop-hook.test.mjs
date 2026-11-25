import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCodexStop, runCodexStopHook, runCodexStopHookCli } from "./codex-stop-hook.mjs";
import { decide as issueGate } from "./issue-gate.mjs";
import { decide as worktreeGate } from "./worktree-gate.mjs";
import { appendRecord, readLedger } from "./ledger.mjs";

const hook = fileURLToPath(new URL("../../../../hooks/stop-gate.sh", import.meta.url));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
const native = (cwd, extra = {}) => ({ hook_event_name: "Stop", session_id: "stable-session", turn_id: "turn",
  cwd, transcript_path: null, model: "codex", permission_mode: "default", stop_hook_active: false,
  last_assistant_message: "Leverage synergy", ...extra });
const leader = { role: "leader" };
function fixture(t) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-codex-stop-")));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(base, "repo"), nested = path.join(root, "nested");
  mkdirSync(nested, { recursive: true });
  git(root, "init", "-q", "-b", "feat/stop");
  git(root, "config", "user.name", "qc"); git(root, "config", "user.email", "qc@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {} } }));
  writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  writeFileSync(path.join(root, "prose.md"), "A clear sentence.\n");
  writeFileSync(path.join(root, "failure.txt"), "");
  git(root, "add", "."); git(root, "commit", "-qm", "fixture");
  mkdirSync(path.join(root, ".git", "qc"));
  const cli = path.join(root, "node_modules", "architecture-harness", "src", "cli");
  mkdirSync(cli, { recursive: true });
  writeFileSync(path.join(cli, "lint-changed.mjs"), "");
  writeFileSync(path.join(cli, "qc.mjs"), 'import {readFileSync} from "node:fs"; const f=readFileSync("failure.txt","utf8"); if(process.argv[2]==="check" && f){console.error(f);process.exit(1)}');
  const env = name => {
    const tmp = path.join(base, name); mkdirSync(tmp, { recursive: true });
    return { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp, QC_STOP_EXTRA: "", CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: base };
  };
  return { root, nested, env, ledger: path.join(root, ".git", "qc", "ledger.jsonl") };
}
const call = input => ({ hook_event_name: "Stop", cwd: input.cwd, session_id: input.session_id, stop_hook_active: input.stop_hook_active, agent_type: "leader" });
const merge = { type: "merge", session: "stable-session", repo: "o/r", pr: 3, branch: "feat/stop", base: "main",
  mergedAt: "2026-10-01T00:00:00Z", issues: [{ repo: "o/r", number: 2 }] };

test("malformed and unsupported inputs refuse before external commands", async () => {
  for (const [input, role] of [["{", "leader"], [native(process.cwd(), { stop_hook_active: "false" }), "leader"],
    [native("relative"), "leader"], [native(process.cwd(), { session_id: "" }), "leader"],
    [native(process.cwd(), { turn_id: "" }), "leader"], [native(process.cwd()), undefined],
    [native(process.cwd()), "worker"], [native(process.cwd(), { agent_id: "child", agent_type: "explorer" }), "leader"],
    [native(process.cwd(), { hook_event_name: "SubagentStop" }), "leader"]]) {
    let called = false;
    const result = await runCodexStopHook(typeof input === "string" ? input : JSON.stringify(input), { role, run: () => { called = true; } });
    assert.equal(result.code, 2); assert.equal(result.stdout, ""); assert.equal(called, false);
    assert.match(result.stderr, /JSON|Stop|identity|directory|role/);
  }
});

test("native root identity, checkout cwd and active flag stay stable across turns", t => {
  const ws = fixture(t), input = native(ws.nested, { stop_hook_active: true });
  assert.deepEqual(normalizeCodexStop(input, leader), { ...call(input), cwd: ws.root });
  assert.equal(normalizeCodexStop({ ...input, turn_id: "next" }, leader).session_id, input.session_id);
  assert.throws(() => normalizeCodexStop(native(path.join(ws.root, "absent")), leader), /directory/);
});

test("unchanged Claude shell decisions match Codex for clean, red, identical retry, changed failure and recovery", async t => {
  const ws = fixture(t), claudeEnv = ws.env("claude"), codexEnv = ws.env("codex");
  const input = native(ws.nested);
  const run = (file, args, options) => {
    assert.equal(file, "bash"); assert.deepEqual(args, [hook]);
    assert.equal(options.cwd, ws.root); assert.equal(options.env.CLAUDE_PROJECT_DIR, ws.root);
    assert.deepEqual(JSON.parse(options.input), { ...call(input), cwd: ws.root, stop_hook_active: JSON.parse(options.input).stop_hook_active });
    return spawnSync(file, args, { ...options, env: { ...options.env, CLAUDE_PLUGIN_ROOT: codexEnv.CLAUDE_PLUGIN_ROOT } });
  };
  for (const [failure, active] of [["", false], ["FAIL prose: use plain words", false], ["FAIL prose: use plain words", true],
    ["FAIL lint: changed failure", true], ["", true]]) {
    writeFileSync(path.join(ws.root, "failure.txt"), failure);
    input.stop_hook_active = active;
    const expected = spawnSync("bash", [hook], { cwd: ws.root, input: JSON.stringify(call(input)), env: claudeEnv, encoding: "utf8" });
    const result = await runCodexStopHook(JSON.stringify(input), { ...leader, env: { ...codexEnv, CLAUDE_PROJECT_DIR: "foreign" }, run });
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    if (expected.status === 2) assert.deepEqual(output, { decision: "block", reason: expected.stderr });
    else assert.deepEqual(output, expected.stdout ? JSON.parse(expected.stdout) : {});
    if (failure && active && /prose/.test(failure)) assert.match(output.systemMessage, /same text.*FAIL prose/);
  }
});

test("shared merged-issue blocks, retry notes, read errors and settled session ledgers match", async t => {
  const ws = fixture(t), input = native(ws.root), clean = () => ({ status: 0, stdout: "", stderr: "" });
  const append = (file, record) => appendRecord(file, record, new Date("2026-10-02T00:00:00Z"));
  for (const [view, active] of [[{ state: "OPEN", comments: [] }, false], [{ state: "OPEN", comments: [] }, true],
    [null, false], [{ state: "CLOSED" }, false]]) {
    input.stop_hook_active = active;
    const gh = args => { assert.deepEqual(args, ["issue", "view", "2", "-R", "o/r", "--json", "state,comments"]); return view && JSON.stringify(view); };
    writeFileSync(ws.ledger, ""); append(ws.ledger, merge);
    const expected = issueGate(call(input), { gh, append }); const records = readLedger(ws.ledger);
    writeFileSync(ws.ledger, ""); append(ws.ledger, merge);
    const result = await runCodexStopHook(JSON.stringify(input), { ...leader, run: clean, gh, append, tmp: path.join(ws.root, "tmp"), worktree: () => null });
    assert.deepEqual(JSON.parse(result.stdout), expected ?? {});
    assert.deepEqual(readLedger(ws.ledger), records);
  }
});

test("CLI writes native refusal JSON and propagates stdin errors", async () => {
  const output = [], errors = [];
  const options = { stdin: [JSON.stringify(native(process.cwd()))], write: value => output.push(value), error: value => errors.push(value),
    run: () => ({ status: 2, stderr: "red", stdout: "" }), issue: () => null, worktree: () => null };
  assert.equal(await runCodexStopHookCli(["--role", "leader"], options), 0);
  assert.deepEqual(JSON.parse(output[0]), { decision: "block", reason: "red" }); assert.deepEqual(errors, []);
  const stdin = { async *[Symbol.asyncIterator]() { throw new Error("stdin failed"); } };
  assert.equal(await runCodexStopHookCli(["--role", "leader"], { ...options, stdin }), 2);
  assert.match(errors[0], /stdin failed/);
});

test("a dirty merged worktree keeps the same advisory and deduplication", async t => {
  const ws = fixture(t), input = native(ws.root);
  writeFileSync(path.join(ws.root, "prose.md"), "Changed prose.\n");
  appendRecord(ws.ledger, { ...merge, issues: [] });
  const expected = worktreeGate(call(input), { tmp: ws.env("claude").TMPDIR });
  assert.match(expected.systemMessage, /Worktree check/); assert.equal(expected.decision, undefined);
  const options = { ...leader, run: () => ({ status: 0, stdout: "", stderr: "" }), tmp: ws.env("codex").TMPDIR };
  assert.deepEqual(JSON.parse((await runCodexStopHook(JSON.stringify(input), options)).stdout), expected);
  assert.deepEqual(JSON.parse((await runCodexStopHook(JSON.stringify(input), options)).stdout), {});
});

test("all shared gates run beside a red shell; notes and command errors survive", async () => {
  const input = JSON.stringify(native(process.cwd())); const seen = [];
  const options = { ...leader, issue: () => { seen.push("issue"); return { decision: "block", reason: "issue refusal" }; },
    worktree: () => { seen.push("worktree"); return { systemMessage: "cleanup note" }; } };
  const result = await runCodexStopHook(input, { ...options, run: () => ({ status: 2, stderr: "red\n", stdout: "" }) });
  assert.deepEqual(seen, ["issue", "worktree"]);
  assert.deepEqual(JSON.parse(result.stdout), { decision: "block", reason: "red\n\nissue refusal", systemMessage: "cleanup note" });
  for (const run of [() => ({ error: new Error("spawn failed") }), () => ({ status: null, signal: "SIGTERM" }),
    () => ({ status: 1, stderr: "bash failed" }), () => ({ status: 0, stdout: "not JSON" }), () => { throw new Error("boundary failed"); }]) {
    const error = await runCodexStopHook(input, { ...options, run });
    assert.equal(error.code, 2); assert.match(error.stderr, /failed|SIGTERM|JSON/);
  }
});
