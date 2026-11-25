import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUsage } from "./codex-usage.mjs";

const breakdown = (inputTokens = 390000) => ({ inputTokens, cachedInputTokens: inputTokens - 1,
  outputTokens: 10000, reasoningOutputTokens: 2000, totalTokens: inputTokens + 10000 });
const event = () => ({ method: "thread/tokenUsage/updated", params: { threadId: "session-1", turnId: "turn-1",
  tokenUsage: { last: breakdown(), total: breakdown(900000), modelContextWindow: 1000000 } } });

test("pinned app-server last usage includes cached input and output exactly once", () => {
  assert.deepEqual(normalizeUsage(event()), { sessionId: "session-1", turnId: "turn-1", tokens: 400000 });
  const cached = event(); cached.params.tokenUsage.last.cacheWriteInputTokens = 3000;
  assert.equal(normalizeUsage(cached).tokens, 400000);
  for (const mutate of [e => { e.method = "turn.completed"; }, e => { delete e.params.turnId; },
    e => { delete e.params.tokenUsage.total; }, e => { e.params.tokenUsage.last.inputTokens = "390000"; },
    e => { e.params.tokenUsage.last.totalTokens = -1; }, e => { e.params.tokenUsage.last.cachedInputTokens = 400000; },
    e => { e.params.tokenUsage.last.outputTokens = NaN; }, e => { e.params.tokenUsage.last.totalTokens = Number.MAX_SAFE_INTEGER + 1; }]) {
    const input = event(); mutate(input); assert.equal(normalizeUsage(input), null);
  }
});

test("unknown Codex usage never falls back to Claude transcript usage", () => {
  for (const value of [null, {}, "malformed", { type: "assistant", message: { usage: { input_tokens: 400000 } } }]) {
    assert.equal(normalizeUsage(value), null);
  }
});
