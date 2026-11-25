import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { normalizeCodexContext } from "./codex-context.mjs";

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
