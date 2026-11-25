import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decideCodexHook, normalizeCodexHook, runCodexHook } from "./codex-hook.mjs";
import { decide as commandGuard } from "./bash-command-guard.mjs";
import { decidePr } from "./pr-guard.mjs";
import { decide as mergeGuard } from "./merge-guard.mjs";

function workspace(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), "qc-codex-hook-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q");
  git("checkout", "-qb", "feat/310-hooks");
  git("remote", "add", "origin", "https://github.com/o/r.git");
  writeFileSync(path.join(cwd, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {} } }));
  git("add", ".");
  git("-c", "user.name=qc", "-c", "user.email=qc@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  return cwd;
}

// rust-v0.172.0 hooks/src/schema.rs and core/src/tools/context.rs: Bash responses are strings, even on failure.
const wire = (cwd, command, extra = {}) => ({ session_id: "stable-parent", turn_id: "turn-1", transcript_path: null,
  cwd, hook_event_name: "PreToolUse", model: "fixture", permission_mode: "default", tool_name: "Bash",
  tool_input: { command }, tool_use_id: "call-1", ...extra });
const claude = (event, role = "leader") => ({ cwd: event.cwd, session_id: event.session_id, agent_type: role,
  ...(event.agent_id ? { agent_id: event.agent_id } : {}), hook_event_name: event.hook_event_name,
  tool_name: "Bash", tool_input: event.tool_input, ...(Object.hasOwn(event, "tool_response") ? { tool_response: event.tool_response } : {}) });

test("pre-tool allow, denial, and context match unchanged Claude decisions without executing actions", async (t) => {
  const cwd = workspace(t);
  const marker = path.join(cwd, "action");
  for (const command of [`echo action > "${marker}"`, "gh pr create", "git -c core.hooksPath=/dev/null commit -m bypass",
    "gh pr merge 7 -R other/repo --match-head-commit abc1234"]) {
    const event = wire(cwd, command);
    const deps = { gh: () => assert.fail("unexpected GitHub call"), commentCheck: async () => null };
    const outputs = [];
    for (const decide of [commandGuard, decidePr, mergeGuard]) {
      const result = await decide(claude(event), deps);
      if (result) outputs.push(result);
      if (result?.hookSpecificOutput?.permissionDecision === "deny") break;
    }
    assert.deepEqual(await decideCodexHook(event, { role: "leader" }, deps), outputs.at(-1) ?? null);
  }
  assert.equal(existsSync(marker), false);
  const event = wire(cwd, "gh pr create --draft", { agent_id: "child-id", agent_type: "default" });
  assert.deepEqual(normalizeCodexHook(event, { role: "implementer" }), claude(event, "implementer"));
  assert.deepEqual(await decideCodexHook(event, { role: "implementer" }), await decidePr(claude(event, "implementer")));
});

test("pre-tool comment context uses the shared merge decision", async (t) => {
  const cwd = workspace(t);
  const event = wire(cwd, "gh pr merge 7 -R other/repo --match-head-commit abc1234");
  const context = { hookSpecificOutput: { additionalContext: "checked comments" } };
  const deps = { commentCheck: async (call) => { assert.equal(call.session_id, "stable-parent"); return context; } };
  const result = await decideCodexHook(event, { role: "leader" }, deps);
  assert.deepEqual(result, await mergeGuard(claude(event), deps));
  assert.match(result.hookSpecificOutput.additionalContext, /checked comments/);
});

test("post success and failure text retain the original result and conservatively use Claude failure bookkeeping", async (t) => {
  for (const state of ["MERGED", "OPEN"]) {
    for (const response of ["merged", "merge failed", ""]) {
      const cwd = workspace(t);
      const event = wire(cwd, "gh pr merge 7 --auto --match-head-commit abc1234", {
        hook_event_name: "PostToolUse", tool_response: response,
      });
      const expected = { ...claude(event), hook_event_name: "PostToolUseFailure" };
      assert.deepEqual(normalizeCodexHook(event, { role: "leader" }), expected);
      const deps = { commentCheck: () => assert.fail("opaque completion cannot acknowledge comments"),
        gh: () => JSON.stringify({ number: 7, url: "https://github.com/o/r/pull/7", state,
        headRefName: "feat/310-hooks", baseRefName: "main", mergedAt: null, body: "Refs #310", closingIssuesReferences: [] }) };
      const ledger = path.join(cwd, ".git", "qc", "ledger.jsonl");
      const result = await decideCodexHook(event, { role: "leader" }, deps);
      const before = existsSync(ledger) ? readFileSync(ledger, "utf8") : "";
      await mergeGuard(expected, deps);
      assert.equal(existsSync(ledger) ? readFileSync(ledger, "utf8") : "", before);
      assert.equal(before.includes('"type":"merge"'), state === "MERGED");
      assert.equal(before.includes('"pending":true'), false);
      assert.equal(result.hookSpecificOutput.hookEventName, "PostToolUse");
      assert.match(result.hookSpecificOutput.additionalContext, /exit status.*unavailable/);
    }
  }
});

test("post-tool shared bookkeeping warnings remain valid Codex system messages", async (t) => {
  const event = wire(workspace(t), "gh pr merge 7 --auto", { hook_event_name: "PostToolUse", tool_response: "unknown" });
  const deps = { gh: () => JSON.stringify({ state: "MERGED", url: "https://github.com/o/r/pull/7", number: 7,
    closingIssuesReferences: {}, body: "" }) };
  const expected = await mergeGuard({ ...claude(event), hook_event_name: "PostToolUseFailure" }, deps);
  assert.match(expected.systemMessage, /ledger failed/);
  assert.equal((await decideCodexHook(event, { role: "leader" }, deps)).systemMessage, expected.systemMessage);
});

test("missing identity, command, result, and unsupported wire shapes never dispatch decisions", async (t) => {
  const event = wire(workspace(t), "echo ok");
  const variants = [null, [], {}, ...["cwd", "session_id", "turn_id", "tool_use_id"].map(key => ({ ...event, [key]: " " })),
    { ...event, cwd: "relative" }, { ...event, cwd: path.join(event.cwd, "missing") },
    { ...event, agent_id: "child", agent_type: "default" }, { ...event, agent_type: "worker" },
    ...["exec_command", "shell", "shell_command", "PowerShell", "apply_patch"].map(tool_name => ({ ...event, tool_name })),
    ...["Stop", "PostToolUseFailure", "PermissionRequest"].map(hook_event_name => ({ ...event, hook_event_name })),
    ...[{}, { command: ["echo", "ok"] }, { cmd: "echo ok" }, { command: " " }].map(tool_input => ({ ...event, tool_input })),
    { ...event, hook_event_name: "PostToolUse" }, { ...event, hook_event_name: "PostToolUse", tool_response: { exit_code: 1 } }];
  for (const input of variants) await assert.rejects(decideCodexHook(input, { role: "leader" }), /Codex hook:/);
  for (const role of [undefined, "", "unknown", "worker"]) await assert.rejects(decideCodexHook(event, { role }), /Codex hook:/);
});

test("CLI blocks evaluation/read errors and emits only native decision or context fields", async (t) => {
  const cwd = workspace(t);
  const output = [], errors = [];
  const boundary = { write: value => output.push(JSON.parse(value)), error: value => errors.push(value) };
  const args = ["--role", "leader"];
  const event = wire(cwd, "gh pr merge 7 --match-head-commit abc1234");
  assert.equal(await runCodexHook(args, { ...boundary, stdin: [JSON.stringify(event)],
    commentCheck: () => { throw new Error("inspection failed"); } }), 2);
  assert.match(errors.pop(), /inspection failed/);
  assert.deepEqual(output, []);
  const stdin = { async *[Symbol.asyncIterator]() { throw new Error("read failed"); } };
  assert.equal(await runCodexHook(args, { ...boundary, stdin }), 2);
  assert.match(errors.pop(), /read failed/);
  assert.equal(await runCodexHook(args, { ...boundary, stdin: [JSON.stringify(wire(cwd, "echo ok"))] }), 0);
  assert.deepEqual(output, []);
  assert.equal(await runCodexHook(args, { ...boundary, stdin: [JSON.stringify(wire(cwd, "git -c core.hooksPath=/dev/null status"))] }), 0);
  assert.deepEqual(Object.keys(output[0]), ["hookSpecificOutput"]);
  assert.deepEqual(Object.keys(output[0].hookSpecificOutput).sort(), ["hookEventName", "permissionDecision", "permissionDecisionReason"]);
  assert.equal(output[0].hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(output[0].hookSpecificOutput.permissionDecision, "deny");
});

const qc = fileURLToPath(new URL("./qc.mjs", import.meta.url));
test("Codex hook CLI fails closed on malformed JSON and unsupported events", () => {
  for (const input of ["{", "null", "[]", JSON.stringify({ hook_event_name: "Stop" })]) {
    const result = spawnSync(process.execPath, [qc, "codex-hook", "--role", "leader"], { input, encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Codex hook:/);
    assert.equal(result.stdout, "");
  }
});
