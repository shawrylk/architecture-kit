import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decide } from "./slot-guard.mjs";

const HOOKS = fileURLToPath(new URL("../../../../hooks/hooks.json", import.meta.url));
const call = (tool_name, tool_input, agent_id = "agent-1") => ({ hook_event_name: "PreToolUse", tool_name, tool_input, agent_id });
const denied = (output) => output?.hookSpecificOutput?.permissionDecision === "deny";

test("a subagent may not touch a slot folder, by a command or by an edit", () => {
  assert.ok(denied(decide(call("Bash", { command: "rm -rf /tmp/architecture-kit/gate-slots/slot-0.json" }), {})));
  assert.ok(denied(decide(call("PowerShell", { command: "Remove-Item C:\\Temp\\architecture-kit\\dispatch\\s1 -Recurse" }), {})));
  assert.ok(denied(decide(call("Write", { file_path: "C:/Temp/architecture-kit/gate-slots/slot-1.json" }), {})));
  assert.ok(denied(decide(call("Bash", { command: "rm -rf D:/slots/slot-0.json" }), { QC_GATE_SLOT_DIR: "D:\\slots" })));
});

test("the main session, the gate-slot command, and the kit's own source pass", () => {
  assert.equal(decide(call("Bash", { command: "rm -rf /tmp/architecture-kit/gate-slots" }, ""), {}), null);
  assert.equal(decide(call("Bash", { command: "npx qc gate-slot -- pnpm check:local" }), {}), null);
  assert.equal(decide(call("Edit", { file_path: "C:/GitHub/architecture-kit/packages/qc-harness/src/cli/dispatch-slot.mjs" }), {}), null);
});

test("hooks.json runs the slot guard before a shell command or an edit", () => {
  const { hooks } = JSON.parse(readFileSync(HOOKS, "utf8"));
  const matchers = hooks.PreToolUse.filter((entry) => entry.hooks.some((hook) => hook.command.includes("slot-guard.mjs"))).map((entry) => entry.matcher);
  assert.deepEqual(matchers, ["Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit"]);
});
