import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { normalizeCodexContext } from "./codex-context.mjs";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const nativeCall = (cwd) => ({ hook_event_name: "PreToolUse", cwd, session_id: "thread", turn_id: "turn", tool_use_id: "call" });

test("source identity requires an explicit trusted role and native pre-tool fields", () => {
  const call = nativeCall(process.cwd());
  assert.deepEqual(normalizeCodexContext(call, { role: "leader" }), { ...call, role: "leader" });
  for (const role of [undefined, "worker", "L1", "unknown"]) assert.throws(() => normalizeCodexContext(call, { role }), /unsupported native context identity/);
  for (const change of [{ hook_event_name: "Stop" }, { turn_id: "" }, { session_id: "../private" }, { tool_use_id: null }, { cwd: "relative" }, { cwd: fileURLToPath(import.meta.url) }, { agent_id: "thread" }]) {
    assert.throws(() => normalizeCodexContext({ ...call, ...change }, { role: "leader" }), /unsupported native context identity/);
  }
  for (const role of ["implementer", "reviewer"]) {
    const worker = { ...call, agent_id: "thread", agent_type: "native-profile" };
    assert.equal(normalizeCodexContext(worker, { role }).role, role);
    assert.throws(() => normalizeCodexContext({ ...worker, agent_id: "root" }, { role }));
    assert.throws(() => normalizeCodexContext(call, { role }));
  }
});

function runtime(t, role = "implementer") {
  const home = mkdtempSync(path.join(os.tmpdir(), "qc-context-runtime-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  mkdirSync(path.join(home, "sessions")); mkdirSync(path.join(home, ".git"));
  const file = path.join(home, "sessions", "native.jsonl");
  const call = { ...nativeCall(home), tool_name: "Bash", tool_input: { command: "npm test" }, transcript_path: file,
    ...(role === "leader" ? {} : { agent_id: "thread", agent_type: "profile" }) };
  const save = (total = 115000, turn = "turn", age = 0, root = "root") => {
    const usage = { input_tokens: total - 1000, cached_input_tokens: total - 1000, output_tokens: 1000, reasoning_output_tokens: 900, total_tokens: total };
    const row = (type, payload, ordinal) => JSON.stringify({ timestamp: new Date(Date.now() - age).toISOString(), ordinal, type, payload }) + "\n";
    writeFileSync(file, row("session_meta", { id: "thread", session_id: role === "leader" ? "thread" : root, cli_version: "0.172.0", cwd: home,
      source: role === "leader" ? "exec" : { subagent: { thread_spawn: { parent_thread_id: root, depth: 1, agent_role: "profile" } } } }, 0) +
      row("token_usage_record", { thread_id: "thread", session_id: role === "leader" ? "thread" : root, turn_id: turn, root_turn_id: turn, response_id: "response", usage, turn_token_usage: usage, thread_token_usage: usage }, 1) +
      row("event_msg", { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage }, rate_limits: null }, 2));
  };
  const run = (change = {}, as = role) => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./qc.mjs", import.meta.url)), "codex-context", "--role", as], {
      input: JSON.stringify({ ...call, ...change }), encoding: "utf8", env: { ...process.env, CODEX_HOME: home },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const directory = path.join(home, "qc-role-budgets");
  const states = () => readdirSync(directory).filter(name => name.endsWith(".json")).map(name => ({ file: path.join(directory, name), ...JSON.parse(readFileSync(path.join(directory, name), "utf8")) }));
  save(); return { home, call, file, save, run, states };
}

test("native worker budgets persist across CLI processes, deduplicate calls and keep closure on missing usage", (t) => {
  const f = runtime(t);
  assert.match(f.run().hookSpecificOutput.additionalContext, /budgets.implementer.remindAt/);
  assert.deepEqual(f.run(), {}); assert.equal(f.states()[0].count, 1);
  assert.deepEqual(f.run({ tool_use_id: "next" }), {}); assert.equal(f.states()[0].count, 2);
  f.save(150000);
  assert.equal(f.run({ tool_use_id: "closed" }).hookSpecificOutput.permissionDecision, "deny");
  rmSync(f.file);
  assert.equal(f.run({ tool_use_id: "missing" }).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(f.run({ tool_use_id: "handoff", tool_input: { command: "git status" } }), {});
  assert.equal(f.states()[0].policy.budgetClosed, true);
});

test("worker policy survives config edits before closure and while handing off without usage", (t) => {
  for (const role of ["implementer", "reviewer"]) {
    const f = runtime(t, role), config = path.join(f.home, "qc.config.json");
    const budget = { remindAt: 10000, handoffAt: 20000 };
    writeFileSync(config, JSON.stringify({ budgets: { [role]: budget } }));
    f.save(15000);
    assert.match(f.run().hookSpecificOutput.additionalContext, new RegExp(`budgets.${role}.remindAt`));
    writeFileSync(config, JSON.stringify({ budgets: { [role]: null } }));
    f.save(20000);
    assert.equal(f.run({ tool_use_id: "close" }).hookSpecificOutput.permissionDecision, "deny");
    rmSync(f.file);
    for (const [index, contents] of [JSON.stringify({ budgets: { [role]: null } }),
      JSON.stringify({ budgets: { [role]: { remindAt: 500000, handoffAt: 900000 } } }), "{", null].entries()) {
      if (contents === null) rmSync(config); else writeFileSync(config, contents);
      const output = f.run({ tool_use_id: `missing${index}` }).hookSpecificOutput;
      assert.equal(output.permissionDecision, "deny");
      assert.match(output.permissionDecisionReason, /handoffAt \(20000\)/);
      assert.deepEqual(f.run({ tool_use_id: `handoff${index}`, tool_input: { command: "git status" } }), {});
      assert.equal(f.states()[0].policy.budgetClosed, true);
      assert.deepEqual(f.states()[0].budget, budget);
    }
  }
});

test("an initially disabled worker policy is retained across processes", (t) => {
  const f = runtime(t), config = path.join(f.home, "qc.config.json");
  writeFileSync(config, JSON.stringify({ budgets: { implementer: null } }));
  f.save(200000); assert.deepEqual(f.run(), {});
  rmSync(config);
  assert.deepEqual(f.run({ tool_use_id: "next" }), {});
  assert.equal(f.states()[0].budget, null);
});

test("missing legacy or invalid policy snapshots fail closed without rewriting state", (t) => {
  const f = runtime(t); f.save(150000); f.run(); const state = f.states()[0];
  const { budget, ...legacy } = state;
  for (const contents of [legacy, ...[null, {}, [], { remindAt: 20, handoffAt: 10 },
    { remindAt: 10, handoffAt: 20, extra: true }, { remindAt: 1, handoffAt: 1e100 }].map(budget => ({ ...state, budget }))]) {
    const encoded = JSON.stringify(contents); writeFileSync(state.file, encoded);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./qc.mjs", import.meta.url)), "codex-context", "--role", "implementer"], {
      input: JSON.stringify(f.call), encoding: "utf8", env: { ...process.env, CODEX_HOME: f.home },
    });
    assert.equal(result.status, 2); assert.equal(result.stdout, "");
    assert.match(result.stderr, /unsupported input or unavailable state/);
    assert.equal(readFileSync(state.file, "utf8"), encoded);
  }
});

test("runtime isolates workflow roles, repositories and threads; stale or wrong-turn usage stays unknown", (t) => {
  const f = runtime(t);
  f.run(); f.run({}, "reviewer"); assert.equal(f.states().length, 2);
  const other = runtime(t); assert.match(other.run().hookSpecificOutput.additionalContext, /remindAt/);
  assert.match(f.run({ session_id: "other", agent_id: "other" }).hookSpecificOutput.additionalContext, /usage unavailable/);
  for (const [turn, age] of [["old", 0], ["turn", 120001]]) {
    const unknown = runtime(t); unknown.save(200000, turn, age);
    assert.match(unknown.run().hookSpecificOutput.additionalContext, /usage unavailable/);
    assert.deepEqual(unknown.run(), {}); assert.equal(unknown.states()[0].policy.budgetClosed, undefined);
  }
});

test("leader CLI never substitutes qc's threshold for unavailable active native settings", (t) => {
  const f = runtime(t, "leader"); f.save(400000);
  assert.match(f.run().hookSpecificOutput.additionalContext, /native settings unavailable.*automatic compaction.*checkpoint/);
  assert.deepEqual(f.run(), {});
  assert.doesNotMatch(JSON.stringify(f.states()), /400000|200000|\/compact|npm test/);
});

test("unreadable, oversized or corrupt state blocks without clearing a closed budget", (t) => {
  const f = runtime(t); f.save(150000); f.run(); const state = f.states()[0];
  for (const contents of ["{", "x".repeat(8193), JSON.stringify({ ...state, count: -1 })]) {
    writeFileSync(state.file, contents);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./qc.mjs", import.meta.url)), "codex-context", "--role", "implementer"], {
      input: JSON.stringify(f.call), encoding: "utf8", env: { ...process.env, CODEX_HOME: f.home },
    });
    assert.equal(result.status, 2); assert.equal(result.stdout, ""); assert.doesNotMatch(result.stderr, /xxxxx|SyntaxError|npm test/);
    assert.equal(readFileSync(state.file, "utf8"), contents);
  }
});

test("concurrent hook processes serialize updates and warning delivery", async (t) => {
  const f = runtime(t);
  const outputs = await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./qc.mjs", import.meta.url)), "codex-context", "--role", "implementer"], { env: { ...process.env, CODEX_HOME: f.home } });
    let output = "", error = ""; child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => error += chunk);
    child.on("error", reject); child.on("close", code => { try { assert.equal(code, 0, error); resolve(JSON.parse(output)); } catch (cause) { reject(cause); } });
    child.stdin.end(JSON.stringify({ ...f.call, tool_use_id: `call${index % 4}` }));
  })));
  assert.equal(outputs.filter(result => result.hookSpecificOutput).length, 1);
  assert.equal(f.states()[0].count, 4);
});

test("repository and session namespaces remain separate in the same persistent storage", (t) => {
  const f = runtime(t); f.save(150000); f.run();
  const cwd = path.join(f.home, "other-repository"); mkdirSync(cwd); mkdirSync(path.join(cwd, ".git"));
  const rows = readFileSync(f.file, "utf8").trimEnd().split("\n").map(JSON.parse);
  rows[0].payload.cwd = cwd;
  writeFileSync(f.file, rows.map(JSON.stringify).join("\n") + "\n");
  assert.equal(f.run({ cwd }).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(f.states().length, 2);
  f.run({ cwd, session_id: "another", agent_id: "another" });
  assert.equal(f.states().length, 3);
  assert.equal(f.states().filter(state => state.policy.budgetClosed).length, 2);
});

test("state directories and held locks fail closed without exposing input", (t) => {
  const f = runtime(t); f.run(); const state = f.states()[0];
  const run = () => spawnSync(process.execPath, [fileURLToPath(new URL("./qc.mjs", import.meta.url)), "codex-context", "--role", "implementer"], {
    input: JSON.stringify(f.call), encoding: "utf8", env: { ...process.env, CODEX_HOME: f.home },
  });
  mkdirSync(`${state.file}.lock`);
  let result = run(); assert.equal(result.status, 2); assert.equal(result.stdout, "");
  rmSync(`${state.file}.lock`, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  rmSync(state.file); mkdirSync(state.file);
  result = run(); assert.equal(result.status, 2); assert.match(result.stderr, /unsupported input or unavailable state/);
  assert.doesNotMatch(result.stderr, /npm test|native.jsonl/);
});

test("persisted source cursor rejects rewind and changed root-session provenance", (t) => {
  const f = runtime(t); f.run(); const original = f.states()[0];
  f.save(200000, "turn", 0, "other-root");
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./qc.mjs", import.meta.url)), "codex-context", "--role", "implementer"], {
    input: JSON.stringify(f.call), encoding: "utf8", env: { ...process.env, CODEX_HOME: f.home },
  });
  assert.equal(result.status, 2); assert.deepEqual(f.states()[0], original);
  writeFileSync(f.file, "{}\n");
  assert.match(f.run().hookSpecificOutput.additionalContext, /usage unavailable/);
  assert.deepEqual(f.states()[0].cursor, original.cursor);
});
