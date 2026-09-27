import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decide } from "./dispatch-guard.mjs";

const GUARD = fileURLToPath(new URL("./dispatch-guard.mjs", import.meta.url));
const HOOKS = fileURLToPath(new URL("../../../../hooks/hooks.json", import.meta.url));

/** A checkout that turns the guard on, one whose swarm section has no dispatch key, one with no config, and a temp folder. */
function workspace(t, dispatch = { maxPromptChars: 80 }) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-dispatch-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const on = path.join(base, "on");
  const off = path.join(base, "off");
  const plain = path.join(base, "plain");
  const tmp = path.join(base, "tmp");
  for (const dir of [on, off, plain]) {
    mkdirSync(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" });
  }
  mkdirSync(tmp);
  mkdirSync(path.join(on, "src"));
  writeFileSync(path.join(on, "qc.config.json"), JSON.stringify({ swarm: { dispatch } }));
  writeFileSync(path.join(off, "qc.config.json"), JSON.stringify({ swarm: { toolCallBudget: 50 } }));
  return { on, off, plain, tmp, slots: path.join(tmp, "architecture-kit", "dispatch") };
}

const agentCall = (cwd, tool_input, extra = {}) => ({
  session_id: "session-aaaa",
  cwd,
  hook_event_name: "PreToolUse",
  tool_name: "Agent",
  tool_input,
  ...extra,
});
const subagentEvent = (cwd, agent_type, hook_event_name = "SubagentStop") => ({
  session_id: "session-aaaa",
  cwd,
  hook_event_name,
  agent_id: "agent-1",
  agent_type,
});
const reasonOf = (output) =>
  output?.hookSpecificOutput?.permissionDecision === "deny" ? output.hookSpecificOutput.permissionDecisionReason : null;
const implementer = {
  subagent_type: "architecture:sdd-implementer",
  description: "Task 1",
  prompt: "Read the brief at plans/task-1-brief.md.",
};

test("a checkout with no config, or a swarm section with no dispatch key, sees no change", (t) => {
  const ws = workspace(t);
  for (const cwd of [ws.off, ws.plain]) {
    assert.equal(decide(agentCall(cwd, { prompt: "x".repeat(500) }), ws.tmp), null);
    assert.equal(decide(agentCall(cwd, implementer), ws.tmp), null);
    assert.equal(decide(agentCall(cwd, implementer), ws.tmp), null);
    assert.equal(decide(subagentEvent(cwd, "architecture:sdd-implementer"), ws.tmp), null);
  }
  assert.equal(existsSync(ws.slots), false);
});

test("the main session's dispatch with no model is refused, and one with a model passes", (t) => {
  const ws = workspace(t);
  assert.match(reasonOf(decide(agentCall(ws.on, { prompt: "p" }), ws.tmp)) ?? "", /names no model/);
  assert.equal(decide(agentCall(ws.on, { prompt: "p", model: "sonnet" }), ws.tmp), null);
});

test("a subagent's dispatch is left to its own definition", (t) => {
  const ws = workspace(t);
  const extra = { agent_id: "agent-9", agent_type: "claude-security:patch-generator" };
  assert.equal(decide(agentCall(ws.on, { subagent_type: "claude-security:explore", prompt: "p" }, extra), ws.tmp), null);
  assert.equal(decide(agentCall(ws.on, implementer, extra), ws.tmp), null);
  assert.equal(existsSync(ws.slots), false);
});

test("the config of the checkout that holds the cwd decides", (t) => {
  const ws = workspace(t);
  assert.match(reasonOf(decide(agentCall(path.join(ws.on, "src"), { prompt: "p" }), ws.tmp)) ?? "", /names no model/);
});

test("a prompt over the limit is refused, and the refusal claims no slot", (t) => {
  const ws = workspace(t);
  const long = { ...implementer, prompt: "x".repeat(81) };
  assert.match(reasonOf(decide(agentCall(ws.on, long), ws.tmp)) ?? "", /81 characters/);
  assert.equal(existsSync(ws.slots), false);
  assert.equal(decide(agentCall(ws.on, implementer), ws.tmp), null);
});

test("a second implementer is refused until the first one stops, and the refusal names the slot file", (t) => {
  const ws = workspace(t);
  assert.equal(decide(agentCall(ws.on, implementer), ws.tmp), null);
  const second = reasonOf(decide(agentCall(ws.on, { ...implementer, subagent_type: "sdd-implementer" }), ws.tmp)) ?? "";
  assert.match(second, /holds the one implementer slot/);
  assert.ok(second.includes(ws.slots), second);
  decide(subagentEvent(ws.on, ""), ws.tmp);
  decide(subagentEvent(ws.on, "architecture:sdd-reviewer"), ws.tmp);
  assert.notEqual(reasonOf(decide(agentCall(ws.on, implementer), ws.tmp)), null);
  decide(subagentEvent(ws.on, "architecture:sdd-implementer"), ws.tmp);
  assert.equal(decide(agentCall(ws.on, implementer), ws.tmp), null);
});

test("a stop in a worktree with no config still frees the slot", (t) => {
  const ws = workspace(t);
  decide(agentCall(ws.on, implementer), ws.tmp);
  decide(subagentEvent(ws.plain, "architecture:sdd-implementer"), ws.tmp);
  assert.equal(decide(agentCall(ws.on, implementer), ws.tmp), null);
});

test("a planner and a reviewer run beside an implementer", (t) => {
  const ws = workspace(t);
  decide(agentCall(ws.on, implementer), ws.tmp);
  assert.equal(decide(agentCall(ws.on, { subagent_type: "architecture:sdd-reviewer", prompt: "p" }), ws.tmp), null);
  assert.equal(decide(agentCall(ws.on, { subagent_type: "architecture:sdd-planner", prompt: "p" }), ws.tmp), null);
});

test("a slot with no stop expires after slotMinutes", (t) => {
  const ws = workspace(t);
  decide(agentCall(ws.on, implementer), ws.tmp);
  assert.notEqual(reasonOf(decide(agentCall(ws.on, implementer), ws.tmp)), null);
  assert.equal(decide(agentCall(ws.on, implementer), ws.tmp, Date.now() + 61 * 60_000), null);
});

test("a resumed implementer holds the slot again", (t) => {
  const ws = workspace(t);
  decide(agentCall(ws.on, implementer), ws.tmp);
  decide(subagentEvent(ws.on, "architecture:sdd-implementer"), ws.tmp);
  decide(subagentEvent(ws.on, "architecture:sdd-implementer", "SubagentStart"), ws.tmp);
  assert.match(reasonOf(decide(agentCall(ws.on, implementer), ws.tmp)) ?? "", /holds the one implementer slot/);
});

test("a config error reaches the session as context and never refuses", (t) => {
  const ws = workspace(t, { slotMinutes: "soon" });
  const output = decide(agentCall(ws.on, { prompt: "p" }), ws.tmp);
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
  assert.match(output.hookSpecificOutput.additionalContext, /Dispatch guard is off: swarm\.dispatch\.slotMinutes/);
});

test("the hook runs as its own process and prints its refusal as JSON", (t) => {
  const ws = workspace(t);
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(agentCall(ws.on, { prompt: "p" })),
    env: { ...process.env, TEMP: ws.tmp, TMP: ws.tmp, TMPDIR: ws.tmp },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(reasonOf(JSON.parse(result.stdout)) ?? "", /names no model/);
});

test("hooks.json runs the guard on Agent, SubagentStart and SubagentStop", () => {
  const { hooks } = JSON.parse(readFileSync(HOOKS, "utf8"));
  const matchersOf = (entries) =>
    (entries ?? []).filter((entry) => entry.hooks.some((hook) => hook.command.includes("dispatch-guard.mjs"))).map((entry) => entry.matcher);
  assert.deepEqual(matchersOf(hooks.PreToolUse), ["Agent"]);
  assert.deepEqual(matchersOf(hooks.SubagentStart), [undefined]);
  assert.deepEqual(matchersOf(hooks.SubagentStop), [undefined]);
});
