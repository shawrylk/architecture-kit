import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexBudgetCall } from "./codex-budget-call.mjs";
import { isHandoffCall } from "./budget.mjs";

const patch = (...lines) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
const call = (cwd, command) => ({ cwd, session_id: "worker", agent_id: "worker", agent_type: "profile",
  role: "implementer", tool_name: "apply_patch", tool_input: { command } });
function fixture(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "qc-native-budget-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  mkdirSync(path.join(cwd, "handoffs")); mkdirSync(path.join(cwd, "src"));
  writeFileSync(path.join(cwd, "handoffs", "next.md"), "old\n");
  writeFileSync(path.join(cwd, "src", "code.mjs"), "old\n");
  return cwd;
}

test("whole-patch adapter reuses shared note policy and retains native identity", (t) => {
  const cwd = fixture(t);
  for (const command of [
    patch("*** Add File: handoffs/new/deep.md", "+resume"),
    patch("*** Update File: handoffs/next.md", "@@", "-old", "+resume"),
    patch("*** Delete File: handoffs/next.md"),
    patch("*** Update File: handoffs/next.md", "*** Move to: handoffs/moved.md", "@@", "-old", "+resume"),
    patch("*** Add File: handoffs/a.md", "+a", "*** Add File: handoffs/b.md", "+b"),
  ]) {
    const input = call(cwd, command), before = structuredClone(input), adapted = codexBudgetCall(input);
    assert.equal(isHandoffCall(adapted), true, command);
    assert.equal(adapted.agent_id, "worker"); assert.equal(adapted.agent_type, "profile");
    assert.equal(adapted.session_id, "worker"); assert.equal(adapted.role, "implementer");
    assert.deepEqual(input, before);
  }
});

test("mixed paths, both move ends, traversal and unsupported patch shapes stay closed", (t) => {
  const cwd = fixture(t);
  for (const command of [
    patch("*** Update File: src/code.mjs", "@@", "-old", "+new"),
    patch("*** Add File: handoffs/a.md", "+a", "*** Delete File: src/code.mjs"),
    patch("*** Delete File: src/code.mjs", "*** Add File: handoffs/a.md", "+a"),
    patch("*** Update File: src/code.mjs", "*** Move to: handoffs/moved.md", "@@", "-old", "+new"),
    patch("*** Update File: handoffs/next.md", "*** Move to: src/moved.mjs", "@@", "-old", "+new"),
    patch("*** Add File: handoffs/../src/new.mjs", "+x"),
    patch("*** Add File: handoffs/a.md", "+a", "*** Surprise"),
    patch("*** Update File: handoffs/next.md"), patch(), "garbage", undefined, [], { patch: "x" },
  ]) {
    const input = call(cwd, command);
    assert.equal(codexBudgetCall(input), input);
    assert.equal(isHandoffCall(codexBudgetCall(input)), false);
  }
  for (const tool_input of [{ patch: patch("*** Add File: handoffs/a.md", "+a") }, "raw", null]) {
    const input = { ...call(cwd), tool_input };
    assert.equal(codexBudgetCall(input), input);
  }
});

test("existing symlink files and ancestors cannot lend source a handoff exception", (t) => {
  const cwd = fixture(t);
  symlinkSync(path.join(cwd, "src"), path.join(cwd, "handoffs", "alias"), process.platform === "win32" ? "junction" : "dir");
  const linked = process.platform === "win32" ? "handoffs/alias/code.mjs" : "handoffs/linked.md";
  if (process.platform !== "win32") symlinkSync(path.join(cwd, "src", "code.mjs"), path.join(cwd, linked));
  symlinkSync(path.join(cwd, "missing"), path.join(cwd, "handoffs", "dangling"), process.platform === "win32" ? "junction" : "dir");
  for (const command of [
    patch("*** Add File: handoffs/alias/new/deep.mjs", "+x"),
    patch(`*** Update File: ${linked}`, "@@", "-old", "+new"),
    patch(`*** Delete File: ${linked}`),
    patch("*** Update File: handoffs/next.md", "*** Move to: handoffs/alias/new.mjs", "@@", "-old", "+new"),
    patch("*** Add File: handoffs/dangling/new.md", "+x"),
    patch("*** Add File: handoffs/next.md/child.md", "+x"),
  ]) assert.equal(isHandoffCall(codexBudgetCall(call(cwd, command))), false, command);
});

test("POSIX literal backslashes cannot impersonate handoff directories", { skip: process.platform === "win32" }, (t) => {
  const cwd = fixture(t), target = path.join(cwd, "src", "fake\\handoffs\\next.md");
  writeFileSync(target, "old\n");
  symlinkSync(target, path.join(cwd, "handoffs", "literal.md"));
  for (const command of [patch("*** Add File: src/fake\\handoffs\\new.md", "+x"),
    patch("*** Update File: handoffs/literal.md", "@@", "-old", "+new")]) {
    assert.equal(isHandoffCall(codexBudgetCall(call(cwd, command))), false);
  }
});

test("Bash handoff commands retain shared policy and unrelated tools gain no exception", (t) => {
  const cwd = fixture(t);
  for (const command of ["git status", "git diff", "cat handoffs/next.md", "git add .", "git commit -m handoff", "git push"]) {
    const input = { ...call(cwd, command), tool_name: "Bash" };
    assert.equal(codexBudgetCall(input), input); assert.equal(isHandoffCall(input), true, command);
  }
  for (const tool_name of ["apply_patch", "functions.apply_patch", "NotebookEdit", "exec_command"]) {
    const input = { ...call(cwd), tool_name, tool_input: { file_path: path.join(cwd, "handoffs", "next.md"), cmd: "echo x" } };
    assert.equal(isHandoffCall(codexBudgetCall(input)), false);
  }
});
