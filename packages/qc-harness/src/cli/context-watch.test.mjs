import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decide, START, STEP, TELL_USER } from "./context-watch.mjs";

function fixture(t, sessionId = "s") {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "context-watch-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const transcript = path.join(tmp, "transcript.jsonl");
  const call = { session_id: sessionId, transcript_path: transcript, hook_event_name: "PostToolUse" };
  let request = 0;
  return {
    tmp,
    call,
    state: path.join(tmp, "claude-context-watch", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`),
    at(tokens, overrides = {}) {
      request += 1;
      appendFileSync(transcript, `${JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T00:00:00Z",
        message: {
          id: `m${request}`,
          model: "m",
          usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens - 1 },
        },
      })}\n`);
      return decide({ ...call, ...overrides }, { tmp });
    },
  };
}

test("keeps the context budgets", () => {
  assert.equal(START, 150_000);
  assert.equal(STEP, 50_000);
  assert.equal(TELL_USER, 300_000);
});

test("speaks once per rising step and resets after compaction", (t) => {
  const f = fixture(t);
  assert.equal(f.at(149_999), null);
  const first = f.at(160_000);
  assert.deepEqual(first, {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext:
        "Context is about 160K tokens. At the next clean break (a task, review, or merge just finished, nothing mid-fix), update the resume notes and ask the user to run /compact before you continue.",
    },
  });
  assert.equal(f.at(160_000), null);
  assert.match(f.at(200_001).hookSpecificOutput.additionalContext, /200K.*\/compact/);
  assert.equal(f.at(300_000).systemMessage, "Context 300K tokens: Claude will ask you to /compact at the next clean break.");
  assert.equal(f.at(100_000), null);
  assert.equal(JSON.parse(readFileSync(f.state, "utf8")).step, -1);
  assert.match(f.at(160_000).hookSpecificOutput.additionalContext, /160K.*\/compact/);
});

test("uses the call's event name and speaks at the exact start", (t) => {
  const f = fixture(t);
  const result = f.at(150_000, { hook_event_name: "UserPromptSubmit" });
  assert.equal(result.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(result.hookSpecificOutput.additionalContext, /150K/);
  assert.equal(Object.hasOwn(result, "systemMessage"), false);
});

test("keeps subagent calls silent without changing the main session's step", (t) => {
  const f = fixture(t);
  assert.equal(f.at(300_000, { agent_id: "a1" }), null);
  assert.match(f.at(160_000, { agent_id: "" }).hookSpecificOutput.additionalContext, /160K/);
});

test("stays silent without a transcript or usage", (t) => {
  const f = fixture(t);
  assert.equal(decide({ session_id: "s" }, { tmp: f.tmp }), null);
  assert.equal(decide(f.call, { tmp: f.tmp }), null);
  writeFileSync(f.call.transcript_path, `${JSON.stringify({ type: "user", message: { content: "hello" } })}\n`);
  assert.equal(decide(f.call, { tmp: f.tmp }), null);
});

test("sanitizes the session id and writes only when the step changes", (t) => {
  const f = fixture(t, "s/../a.b:1_-Z");
  f.at(160_000);
  assert.deepEqual(JSON.parse(readFileSync(f.state, "utf8")), { step: 0 });
  utimesSync(f.state, 1, 1);
  const before = statSync(f.state).mtimeMs;
  assert.equal(f.at(199_999), null);
  assert.equal(statSync(f.state).mtimeMs, before);
  assert.equal(f.at(149_999), null);
  assert.deepEqual(JSON.parse(readFileSync(f.state, "utf8")), { step: -1 });
});

test("registers the context watch for prompts and all tool calls", () => {
  const { hooks } = JSON.parse(readFileSync(new URL("../../../../hooks/hooks.json", import.meta.url), "utf8"));
  const command = 'node "${CLAUDE_PLUGIN_ROOT}/packages/qc-harness/src/cli/context-watch.mjs"';
  for (const event of ["UserPromptSubmit", "PostToolUse"]) {
    const group = hooks[event]?.find((entry) => entry.hooks.some((hook) => hook.command === command));
    assert.ok(group, `${event} has a context watch group`);
    assert.deepEqual(group.hooks, [{ type: "command", command, timeout: 10 }]);
    if (event === "PostToolUse") assert.equal(group.matcher, "*");
    else assert.equal(Object.hasOwn(group, "matcher"), false);
  }
});
