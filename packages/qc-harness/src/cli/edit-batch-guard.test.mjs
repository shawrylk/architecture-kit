import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CLAIM_TTL_MS, decide, pathKey } from "./edit-batch-guard.mjs";

const GUARD = fileURLToPath(new URL("./edit-batch-guard.mjs", import.meta.url));

/** An adopted checkout, a checkout with no config, and a temp folder for the batch state. */
function workspace(t) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-edit-batch-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const adopted = path.join(base, "adopted");
  const plain = path.join(base, "plain");
  const tmp = path.join(base, "tmp");
  for (const dir of [adopted, plain, tmp]) mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: adopted, stdio: "pipe" });
  execFileSync("git", ["init", "-q"], { cwd: plain, stdio: "pipe" });
  writeFileSync(path.join(adopted, "qc.config.json"), "{}");
  return { adopted, plain, tmp, file: path.join(adopted, "src", "a.ts") };
}

const callOf = (hook_event_name, file, { agent, tool = "Edit" } = {}) => ({
  session_id: "session-aaaa",
  ...(agent ? { agent_id: agent, agent_type: "general-purpose" } : {}),
  cwd: path.dirname(path.dirname(file)),
  hook_event_name,
  tool_name: tool,
  tool_input: { file_path: file, old_string: "a", new_string: "b" },
});
const batchEnd = (agent) => ({
  session_id: "session-aaaa",
  ...(agent ? { agent_id: agent } : {}),
  hook_event_name: "PostToolBatch",
  tool_calls: [],
});
const isDenied = (output) => output?.hookSpecificOutput?.permissionDecision === "deny";

test("two edits to one path in one batch: the second is denied and told to wait for the result", (t) => {
  const ws = workspace(t);
  assert.equal(decide(callOf("PreToolUse", ws.file), ws.tmp), null);
  const output = decide(callOf("PreToolUse", ws.file, { tool: "Write" }), ws.tmp);
  assert.ok(isDenied(output));
  assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /one edit per file per parallel block: send it after this result/);
});

test("a sequential pair passes: the batch event ends the claim", (t) => {
  const ws = workspace(t);
  assert.equal(decide(callOf("PreToolUse", ws.file, { tool: "MultiEdit" }), ws.tmp), null);
  decide(callOf("PostToolUse", ws.file), ws.tmp);
  decide(batchEnd(), ws.tmp);
  assert.equal(decide(callOf("PreToolUse", ws.file), ws.tmp), null);
});

test("a batch event before any claim writes nothing", (t) => {
  const ws = workspace(t);
  decide(batchEnd(), ws.tmp);
  assert.equal(existsSync(path.join(ws.tmp, "architecture-kit", "edit-batch")), false);
});

test("once the agent has seen a batch event, its result alone does not end the claim", (t) => {
  const ws = workspace(t);
  decide(callOf("PreToolUse", ws.file), ws.tmp);
  decide(batchEnd(), ws.tmp);
  assert.equal(decide(callOf("PreToolUse", ws.file), ws.tmp), null);
  decide(callOf("PostToolUse", ws.file), ws.tmp);
  assert.ok(isDenied(decide(callOf("PreToolUse", ws.file), ws.tmp)));
});

test("before any batch event, the result of the edit ends the claim", (t) => {
  const ws = workspace(t);
  assert.equal(decide(callOf("PreToolUse", ws.file, { agent: "agent-1" }), ws.tmp), null);
  decide(callOf("PostToolUse", ws.file, { agent: "agent-1" }), ws.tmp);
  assert.equal(decide(callOf("PreToolUse", ws.file, { agent: "agent-1" }), ws.tmp), null);
});

test("a claim left behind expires", (t) => {
  const ws = workspace(t);
  decide(batchEnd(), ws.tmp);
  assert.equal(decide(callOf("PreToolUse", ws.file), ws.tmp), null);
  assert.ok(isDenied(decide(callOf("PreToolUse", ws.file), ws.tmp)));
  assert.equal(decide(callOf("PreToolUse", ws.file), ws.tmp, Date.now() + CLAIM_TTL_MS + 1000), null);
});

test("different agents, and the main session, do not block each other", (t) => {
  const ws = workspace(t);
  assert.equal(decide(callOf("PreToolUse", ws.file, { agent: "agent-1" }), ws.tmp), null);
  assert.equal(decide(callOf("PreToolUse", ws.file, { agent: "agent-2" }), ws.tmp), null);
  assert.equal(decide(callOf("PreToolUse", ws.file), ws.tmp), null);
  assert.ok(isDenied(decide(callOf("PreToolUse", ws.file, { agent: "agent-2" }), ws.tmp)));
  decide(batchEnd("agent-2"), ws.tmp);
  assert.equal(decide(callOf("PreToolUse", ws.file, { agent: "agent-2" }), ws.tmp), null);
  assert.ok(isDenied(decide(callOf("PreToolUse", ws.file, { agent: "agent-1" }), ws.tmp)));
});

test("a repository with no qc.config.json is never guarded, and other tools are ignored", (t) => {
  const ws = workspace(t);
  const file = path.join(ws.plain, "src", "a.ts");
  decide(callOf("PreToolUse", file), ws.tmp);
  assert.equal(decide(callOf("PreToolUse", file), ws.tmp), null);
  decide(callOf("PreToolUse", ws.file, { tool: "Read" }), ws.tmp);
  assert.equal(decide(callOf("PreToolUse", ws.file), ws.tmp), null);
});

test("a path key is absolute with forward slashes, and case-blind on Windows only", () => {
  assert.equal(pathKey("C:\\Repo\\Src\\A.ts", "C:\\", "win32"), "c:/repo/src/a.ts");
  assert.equal(pathKey("src/A.ts", "C:\\Repo", "win32"), "c:/repo/src/a.ts");
  assert.equal(pathKey("/repo/Src/A.ts", "/", "linux"), "/repo/Src/A.ts");
  assert.equal(pathKey("A.ts", "/repo", "linux"), "/repo/A.ts");
});

test("the hook process prints a deny for the second claim and nothing for the batch event", (t) => {
  const ws = workspace(t);
  const run = (call) => {
    const result = spawnSync(process.execPath, [GUARD], {
      input: JSON.stringify(call),
      env: { ...process.env, TEMP: ws.tmp, TMP: ws.tmp, TMPDIR: ws.tmp },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim() === "" ? null : JSON.parse(result.stdout);
  };
  assert.equal(run(callOf("PreToolUse", ws.file)), null);
  assert.ok(isDenied(run(callOf("PreToolUse", ws.file))));
  assert.equal(run(batchEnd()), null);
  assert.equal(run(callOf("PreToolUse", ws.file)), null);
});
