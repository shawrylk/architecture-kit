import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./qc.mjs", import.meta.url));
function invoke(command, input, extra = {}, args = ["--role", "leader"]) {
  const env = { ...process.env };
  delete env.QC_ROLE;
  for (const key of Object.keys(env)) if (key.startsWith("QC_CODEX_")) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, command, ...args], { env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject);
    child.on("close", status => resolve({ status, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
const native = { hook_event_name: "PreToolUse", cwd: process.cwd(), session_id: "thread", turn_id: "turn", tool_use_id: "tool", tool_name: "Bash", tool_input: { command: "git status" } };
test("real hook CLI blocks inherited workers and partial channel leader fallback", async () => {
  for (const env of [{ QC_CODEX_WORKER: "1" }, { QC_CODEX_REPORT_PORT: "1234" }, { QC_CODEX_REPORT_TOKEN: "secret" }]) {
    const result = await invoke("codex-hook", JSON.stringify(native), env);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
  }
});

test("every real producer rejects worker markers, configured aliases and raw byte failures", async () => {
  for (const command of ["codex-hook", "codex-context", "codex-stop-hook", "codex-checkpoint"]) {
    const args = command === "codex-checkpoint" ? [] : ["--role", "leader"];
    const input = command === "codex-checkpoint" ? { ...native, hook_event_name: "SessionStart", source: "startup" } :
      command === "codex-stop-hook" ? { ...native, hook_event_name: "Stop", stop_hook_active: false } : native;
    const invalid = Buffer.concat([Buffer.from(JSON.stringify(input).slice(0, -1) + ',"extra":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    for (const env of [{ QC_CODEX_WORKER: "0" }, { QC_ROLE: "reviewer" }, { QC_CODEX_REPORT_PORT: "" }, { QC_CODEX_REPORT_TOKEN: "secret" }]) {
      const result = await invoke(command, JSON.stringify(input), env, args);
      assert.equal(result.status, 2, command); assert.equal(result.stdout, ""); assert.doesNotMatch(result.stderr, /secret/);
    }
    for (const raw of [invalid, Buffer.from("\ufeff" + JSON.stringify(input)), JSON.stringify({ ...input, extra: "é".repeat(33000) }), "{"]) {
      const result = await invoke(command, raw, {}, args);
      assert.equal(result.status, 2, command); assert.equal(result.stdout, "");
    }
  }
  const exact = JSON.stringify({ ...native, extra: "" });
  const result = await invoke("codex-hook", exact.replace('"extra":""', '"extra":"' + "x".repeat(65536 - Buffer.byteLength(exact)) + '"'));
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "");
});

test("real hook CLI blocks dead and malformed channels without legacy fallback", async () => {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = String(server.address().port);
  await new Promise(resolve => server.close(resolve));
  for (const env of [{ QC_CODEX_REPORT_PORT: port, QC_CODEX_REPORT_TOKEN: "a".repeat(64) },
    { QC_CODEX_REPORT_PORT: "bad", QC_CODEX_REPORT_TOKEN: "a".repeat(64) }]) {
    const result = await invoke("codex-hook", JSON.stringify(native), env);
    assert.equal(result.status, 2); assert.equal(result.stdout, ""); assert.doesNotMatch(result.stderr, /a{64}/);
  }
});

test("real CLI routes original startup, recovery, action, post and Stop to one owned reservation", { skip: process.platform === "win32" }, async t => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { once } = await import("node:events");
  const { createCodexRuntime } = await import("./codex-runtime.mjs");
  const { createCodexBridge } = await import("./codex-bridge.mjs");
  const { checkpointPathOf } = await import("./checkpoint.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "qc-cli-channel-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  mkdirSync(path.join(dir, ".git")); mkdirSync(path.join(dir, "sessions"));
  writeFileSync(path.join(dir, "qc.config.json"), "{}");
  const executable = path.join(dir, "native");
  writeFileSync(executable, '#!/bin/sh\nread -r thread\nprintf \'{"type":"thread.started","thread_id":"%s"}\\n\' "$thread"\ncat >/dev/null\n', { mode: 0o700 });
  const transcript = path.join(dir, "sessions", "usage.jsonl"), timestamp = new Date().toISOString();
  const usage = { input_tokens: 14000, cached_input_tokens: 14000, output_tokens: 1000, reasoning_output_tokens: 900, total_tokens: 15000 };
  const row = (type, payload, ordinal) => JSON.stringify({ type, payload, ordinal, timestamp }) + "\n";
  writeFileSync(transcript, row("session_meta", { id: "thread", session_id: "root", cwd: dir, cli_version: "0.172.0", source: "exec" }, 0) +
    row("token_usage_record", { thread_id: "thread", session_id: "root", turn_id: "turn", root_turn_id: "turn", response_id: "response", usage, turn_token_usage: usage, thread_token_usage: usage }, 1) +
    row("event_msg", { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } }, 2));
  const runtime = createCodexRuntime({ worktree: dir, executable, workflowId: "workflow", codexHome: dir,
    config: { budgets: { implementer: { remindAt: 10000, handoffAt: 20000 } } } });
  const reservation = runtime.reserve({ role: "implementer", workflowParentId: "parent" }), seen = [];
  // Observe the actual runtime methods without replacing their validation or decisions.
  const observed = Object.fromEntries(["startup", "recover", "hook", "validate", "ready"].map(name => [name, (...args) => {
    if (["startup", "recover", "hook"].includes(name)) seen.push(structuredClone(args[name === "startup" ? 2 : 1]));
    return runtime[name](...args);
  }]));
  let stop;
  const bridge = await createCodexBridge({ runtime: observed, reservation, onStop: (input, message) => { stop = { input, message }; } });
  t.after(() => bridge.close());
  const env = { ...bridge.env, QC_CODEX_WORKER: "1", QC_ROLE: "implementer" };
  const send = (input, args = []) => invoke("codex-hook", JSON.stringify(input), env, args);
  const startup = { hook_event_name: "SessionStart", source: "startup", session_id: "thread", cwd: dir, transcript_path: transcript, model: "fixture", permission_mode: "default" };
  const ack = await send(startup); // Must finish before child launch/readiness.
  assert.equal(ack.status, 0); assert.equal(ack.stdout, ""); assert.deepEqual(seen[0], startup);
  const child = runtime.launch(reservation);
  t.after(() => { child.stdin.end(); child.kill(); });
  await once(child, "spawn"); child.stdin.write("thread\n");
  const proof = await bridge.ready(); assert.equal(proof.role, "implementer");
  const checkpoint = checkpointPathOf(dir, "thread"), text = "## Goal\nconcrete CLI recovery\n## Rules\n## Tasks\n## Next\n";
  mkdirSync(path.dirname(checkpoint), { recursive: true }); writeFileSync(checkpoint, text);
  for (const source of ["compact", "resume"]) {
    const result = await send({ ...startup, source });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } });
    assert.deepEqual(seen.at(-1), { ...startup, source }); assert.strictEqual(await bridge.ready(), proof);
  }
  const call = { ...native, cwd: dir, transcript_path: transcript, tool_input: { command: "git -c core.hooksPath=/dev/null status" } };
  const denied = await send(call, ["--role", "leader"]);
  assert.equal(denied.status, 0);
  const output = JSON.parse(denied.stdout).hookSpecificOutput;
  assert.equal(output.permissionDecision, "deny"); assert.match(output.permissionDecisionReason, /hooksPath/i);
  assert.match(output.additionalContext, /budgets\.implementer\.remindAt/); assert.deepEqual(seen.at(-1), call);
  const state = () => readdirSync(path.join(dir, "qc-role-budgets")).map(file => readFileSync(path.join(dir, "qc-role-budgets", file), "utf8"));
  const post = { ...call, hook_event_name: "PostToolUse", tool_response: "opaque", tool_input: { command: "echo ok" } }, before = state();
  const posted = await send(post); assert.equal(posted.status, 0);
  assert.match(JSON.parse(posted.stdout).hookSpecificOutput.additionalContext, /exit status is unavailable/);
  assert.deepEqual(seen.at(-1), post); assert.deepEqual(state(), before);
  const stopped = { ...startup, hook_event_name: "Stop", turn_id: "turn", stop_hook_active: false, last_assistant_message: "actual handback" };
  const result = await send(stopped); assert.equal(result.status, 0); assert.equal(result.stdout, "");
  assert.deepEqual(stop, { input: stopped, message: stopped.last_assistant_message });
  for (const extra of [{ role: "leader" }, { agent_id: "forged", agent_type: "leader" }, { session_id: "sibling" }, { tool_name: "unsupported" }]) {
    const result = await send({ ...call, ...extra }); assert.equal(result.status, 2); assert.equal(result.stdout, "");
  }
  const forged = { ...call, proof: { ...proof, role: "leader" }, admission: { role: "leader" } };
  assert.equal(JSON.parse((await send(forged)).stdout).hookSpecificOutput.permissionDecision, "deny");
  for (const [command, input, args] of [["codex-context", call, ["--role", "leader"]], ["codex-stop-hook", stopped, ["--role", "leader"]], ["codex-checkpoint", startup, []]]) {
    const count = seen.length, result = await invoke(command, JSON.stringify(input), env, args);
    assert.equal(result.status, 2); assert.equal(result.stdout, ""); assert.match(result.stderr, /codex-hook/); assert.equal(seen.length, count);
  }
  const wrong = await invoke("codex-hook", JSON.stringify(call), { ...env, QC_CODEX_REPORT_TOKEN: "b".repeat(64) });
  assert.equal(wrong.status, 2); assert.equal(wrong.stdout, ""); assert.doesNotMatch(wrong.stderr, /b{64}/);
  runtime.terminal(reservation);
  assert.equal((await send(call)).status, 2);
});
