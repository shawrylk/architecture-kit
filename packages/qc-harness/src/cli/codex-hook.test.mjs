import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decideCodexHook, normalizeCodexHook, runCodexHook } from "./codex-hook.mjs";
import { decide as commandGuard } from "./bash-command-guard.mjs";
import { decidePr } from "./pr-guard.mjs";
import { decide as mergeGuard } from "./merge-guard.mjs";
import { createCodexRuntime } from "./codex-runtime.mjs";
import { decideGate } from "./gate.mjs";
import { decideCodexEdit } from "./codex-edit-hook.mjs";

async function admitted(t, cwd, session = "external-thread") {
  const executable = path.join(cwd, "native-fixture");
  writeFileSync(executable, `#!/bin/sh\nread -r thread\nprintf '{"type":"thread.started","thread_id":"%s"}\\n' "$thread"\ncat >/dev/null\n`, { mode: 0o700 });
  const runtime = createCodexRuntime({ worktree: cwd, executable, workflowId: "workflow", codexHome: cwd });
  const admission = runtime.reserve({ role: "implementer", workflowParentId: "parent" });
  mkdirSync(path.join(cwd, "sessions"), { recursive: true });
  const transcript = path.join(cwd, "sessions", `${session}.jsonl`);
  writeFileSync(transcript, JSON.stringify({ type: "session_meta", ordinal: 0, timestamp: new Date().toISOString(),
    payload: { id: session, session_id: "distinct-native-root", cwd, cli_version: "0.172.0", source: "exec" } }) + "\n");
  const child = runtime.launch(admission);
  t.after(() => { child.stdin.end(); child.kill(); });
  await once(child, "spawn");
  child.stdin.write(session + "\n");
  runtime.startup(admission, admission.hookCredential, { cwd, session_id: session, transcript_path: transcript, hook_event_name: "SessionStart", source: "startup" });
  await runtime.ready(admission);
  return { runtime, admission, child, transcript, event: command => wire(cwd, command, { session_id: session, transcript_path: transcript }) };
}

test("admitted top-level workers match manual worker command and PR decisions without native identity rewrites", { skip: process.platform === "win32" }, async t => {
  const cwd = workspace(t), f = await admitted(t, cwd);
  const deps = { gh: () => assert.fail("unexpected GitHub call"), commentCheck: async () => null };
  for (const command of ["echo ok", "git -c core.hooksPath=/dev/null status", "gh pr create --draft", "gh pr ready 7", "gh pr merge 7 --auto"]) {
    const input = f.event(command), original = structuredClone(input);
    const manual = await decideGate({ cwd, session: input.session_id, role: "implementer", command }, deps);
    const result = await decideCodexHook(input, { admission: f.admission }, deps);
    assert.equal(result?.hookSpecificOutput?.permissionDecision ?? "allow", manual.decision);
    assert.equal(result?.hookSpecificOutput?.permissionDecisionReason ?? null, manual.reason);
    if (command.startsWith("gh pr")) assert.equal(manual.decision, "deny");
    assert.deepEqual(input, original);
    assert.equal(input.agent_id, undefined); assert.equal(input.agent_type, undefined);
  }
});

test("external admission rejects forgery, sibling identity, checkout/session/provenance conflicts and retired incarnations", { skip: process.platform === "win32" }, async t => {
  const cwd = workspace(t), f = await admitted(t, cwd), sibling = await admitted(t, cwd, "sibling-thread");
  const input = f.event("gh pr create --draft"), proof = f.runtime.validate(f.admission, input);
  assert.equal(proof.nativeRootSessionId, "distinct-native-root");
  assert.notEqual(proof.incarnation, sibling.runtime.validate(sibling.admission, sibling.event("echo ok")).incarnation);
  for (const admission of [null, {}, JSON.parse(JSON.stringify(proof)), sibling.admission]) {
    await assert.rejects(decideCodexHook(input, { admission }), /unavailable/);
  }
  const other = workspace(t), original = structuredClone(input);
  for (const extra of [{ cwd: other }, { session_id: "wrong-thread" }, { role: "leader" },
    { agent_id: "forged", agent_type: "default" }, { agent_id: input.session_id }, { agent_type: "leader" },
    { transcript_path: path.join(cwd, "sessions", "other.jsonl") }]) {
    await assert.rejects(decideCodexHook({ ...input, ...extra }, { admission: f.admission }), /unavailable/);
  }
  await assert.rejects(decideCodexHook(input, { admission: f.admission, role: "leader" }), /conflict/);
  const forged = { ...input, admission: proof, proof: { ...proof, role: "leader" }, nativeRootSessionId: "forged" };
  assert.equal((await decideCodexHook(forged, { admission: f.admission })).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(input, original);
  assert.equal(await runCodexHook(["--role", "implementer"], { stdin: [JSON.stringify(forged)], error: () => {} }), 2);
  await assert.rejects(decideCodexHook({ ...input, tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Add File: a\n+x\n*** End Patch" } },
    { admission: f.admission }, { editGuards: [() => { throw new Error("inspection failed"); }] }), /inspection failed/);
  const header = JSON.parse(readFileSync(f.transcript, "utf8")); header.payload.session_id = "conflicting-root";
  writeFileSync(f.transcript, JSON.stringify(header) + "\n");
  await assert.rejects(decideCodexHook(input, { admission: f.admission }), /unavailable/);
  f.runtime.terminal(f.admission);
  const replacement = await admitted(t, cwd);
  await assert.rejects(decideCodexHook(replacement.event("echo ok"), { admission: f.admission }), /unavailable/);
  sibling.child.stdin.end(); await once(sibling.child, "exit");
  await assert.rejects(decideCodexHook(sibling.event("echo ok"), { admission: sibling.admission }), /unavailable/);
});

test("external patch fanout uses workflow identity for every path and leaves native context state intact", { skip: process.platform === "win32" }, async t => {
  const cwd = workspace(t), f = await admitted(t, cwd), options = { admission: f.admission };
  mkdirSync(path.join(cwd, ".claude"));
  const config = value => writeFileSync(path.join(cwd, "qc.config.json"), JSON.stringify(value));
  const patch = (...lines) => ({ ...f.event(["*** Begin Patch", ...lines, "*** End Patch"].join("\n")), tool_name: "apply_patch" });
  const shared = input => ({ cwd, session_id: input.session_id, agent_id: input.session_id, agent_type: "implementer",
    hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: input.tool_input });
  const check = async (input, expected) => {
    const original = structuredClone(input), result = await decideCodexHook(input, options);
    assert.deepEqual(result, await decideCodexEdit(shared(input)));
    if (expected === null) assert.equal(result, null);
    else assert.match(result.hookSpecificOutput.permissionDecisionReason ?? result.hookSpecificOutput.additionalContext, expected);
    assert.deepEqual(input, original);
  };
  const contextInput = f.event("echo ok");
  await f.runtime.context(f.admission, contextInput);
  const directory = path.join(cwd, "qc-role-budgets"), files = readdirSync(directory);
  const before = files.map(file => readFileSync(path.join(directory, file), "utf8"));
  await check(patch("*** Add File: okay.ts", "+ok"), null);
  writeFileSync(path.join(cwd, ".claude/work-order.local.json"), JSON.stringify({ paths: ["okay.ts"] }));
  await check(patch("*** Add File: okay.ts", "+ok"), null);
  await check(patch("*** Add File: okay.ts", "+ok", "*** Delete File: denied.ts"), /outside this work order/);
  rmSync(path.join(cwd, ".claude/work-order.local.json"));
  await check(patch("*** Add File: okay.ts", "+ok", "*** Add File: routes.generated.ts", "+x"), /Generated-file guard/);
  config({ swarm: { dispatch: {}, direct: false } });
  await check(patch("*** Add File: okay.ts", "+ok", "*** Add File: other.ts", "+x"), null);
  await check(patch("*** Add File: okay.ts", "+ok", "*** Delete File: architecture-kit/gate-slots/slot.json"), /Slot guard/);
  mkdirSync(path.join(cwd, "components"));
  writeFileSync(path.join(cwd, "components/Button.tsx"), "export function Button() { return <button />; }\n");
  config({ ui: { componentRoots: ["components"] } });
  await check(patch("*** Add File: components/NewButton.tsx", "+export function Button() {}"), /Existing components.*Button/);
  const seen = [], input = patch("*** Add File: a", "+x", "*** Add File: b", "+y");
  await decideCodexHook(input, options, { editGuards: Array.from({ length: 5 }, (_, i) => call => {
    assert.equal(call.agent_id, input.session_id); assert.equal(call.agent_type, "implementer");
    assert.equal(call.session_id, input.session_id); seen.push([i, path.basename(call.tool_input.file_path)]);
  }) });
  assert.deepEqual(seen, ["a", "b"].flatMap(file => Array.from({ length: 5 }, (_, i) => [i, file])));
  assert.deepEqual(readdirSync(directory), files);
  assert.deepEqual(files.map(file => readFileSync(path.join(directory, file), "utf8")), before);
  assert.equal(contextInput.agent_id, undefined); assert.equal(contextInput.agent_type, undefined);
  assert.equal(f.runtime.validate(f.admission, contextInput).nativeRootSessionId, "distinct-native-root");
});

test("admitted opaque Bash posts cannot acknowledge comments or create pending merge success", { skip: process.platform === "win32" }, async t => {
  const cwd = workspace(t), f = await admitted(t, cwd);
  for (const tool_response of ["merged", "exit_code: 0", "merge failed"]) {
    const input = { ...f.event("gh pr merge 7 --auto"), hook_event_name: "PostToolUse", tool_response }, original = structuredClone(input);
    const deps = { commentCheck: () => assert.fail("opaque output cannot acknowledge comments"),
      gh: () => JSON.stringify({ state: "OPEN", number: 7, url: "https://github.com/o/r/pull/7" }) };
    const expected = { ...claude(input, "implementer"), agent_id: input.session_id, hook_event_name: "PostToolUseFailure" };
    const result = await decideCodexHook(input, { admission: f.admission }, deps);
    const sharedResult = await mergeGuard(expected, deps);
    assert.equal(result.systemMessage, sharedResult?.systemMessage);
    assert.match(result.hookSpecificOutput.additionalContext, /exit status.*unavailable/);
    assert.equal(existsSync(path.join(cwd, ".git", "qc", "ledger.jsonl")), false);
    assert.deepEqual(input, original);
  }
});

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
    ...["exec_command", "shell", "shell_command", "PowerShell"].map(tool_name => ({ ...event, tool_name })),
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
test("pinned apply_patch command and string result retain event and explicit worker identity", (t) => {
  const event = wire(workspace(t), "*** Begin Patch\n*** End Patch", { tool_name: "apply_patch",
    agent_id: "native-child", agent_type: "default", hook_event_name: "PostToolUse", tool_response: "Success." });
  const call = normalizeCodexHook(event, { role: "implementer" });
  assert.equal(call.hook_event_name, "PostToolUse"); assert.equal(call.tool_name, "apply_patch");
  assert.equal(call.agent_id, "native-child"); assert.equal(call.agent_type, "implementer");
  assert.deepEqual(call.tool_input, event.tool_input); assert.equal(call.tool_response, "Success.");
});
test("Codex hook CLI fails closed on malformed JSON and unsupported events", () => {
  for (const input of ["{", "null", "[]", JSON.stringify({ hook_event_name: "Stop" })]) {
    const result = spawnSync(process.execPath, [qc, "codex-hook", "--role", "leader"], { input, encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Codex hook:/);
    assert.equal(result.stdout, "");
  }
});
