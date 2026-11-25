// Wire boundary pinned to openai/codex rust-v0.172.0 hooks/src/schema.rs and core/src/tools/context.rs.
import { codexHookChannel, readCodexNativeInput } from "./codex-hook-channel.mjs";
import { reportCodexHook } from "./codex-bridge.mjs";
import { statSync } from "node:fs";
import path from "node:path";
import { decide as commandGuard } from "./bash-command-guard.mjs";
import { decidePr } from "./pr-guard.mjs";
import { decide as mergeGuard } from "./merge-guard.mjs";
import { decideCodexEdit } from "./codex-edit-hook.mjs";
import { codexAdmissionOf } from "./codex-runtime.mjs";
import { sharedWorkflowIdentity } from "./gate.mjs";

const ROLES = new Set(["leader", "worker", "implementer", "reviewer"]);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const GAP = "Codex 0.172.0 command exit status is unavailable in Bash post hooks; only confirmed merges are recorded. Success-only comment acknowledgments and pending merges are unsupported.";
const fail = (reason) => { throw new Error(`Codex hook: ${reason}`); };

/** Legacy roles come from trusted configuration; external workflow identity requires a live reservation. */
export function normalizeCodexHook(input, { role, admission } = {}) {
  if (!object(input) || !["PreToolUse", "PostToolUse"].includes(input.hook_event_name)) fail("unsupported event; expected PreToolUse or PostToolUse");
  const proof = admission === undefined ? null : codexAdmissionOf(admission, input);
  if (proof) {
    if (role !== undefined && role !== proof.role) fail("role conflicts with admitted workflow identity");
    role = proof.role;
  }
  if (!ROLES.has(role)) fail("an explicit workflow role is required");
  if (![input.cwd, input.session_id, input.turn_id, input.tool_use_id].every(text)) fail("missing working directory or stable session/turn/tool identity");
  if (!path.isAbsolute(input.cwd)) fail("working directory must be absolute and local");
  try {
    if (!statSync(input.cwd).isDirectory()) fail("working directory is not a directory");
  } catch {
    fail("working directory cannot be read as a directory");
  }
  if (proof || role === "leader" ? input.agent_id !== undefined || input.agent_type !== undefined : !text(input.agent_id) || !text(input.agent_type)) {
    fail("role conflicts with native subagent identity");
  }
  if (!["Bash", "apply_patch"].includes(input.tool_name) || !object(input.tool_input) || !text(input.tool_input.command)) fail("unsupported tool or command representation; expected tool_input.command string");
  const post = input.hook_event_name === "PostToolUse";
  if (post && typeof input.tool_response !== "string") fail("expected the pinned tool output string");
  return {
    // This projection is only for shared action policy. Context/usage keeps the original native envelope.
    cwd: input.cwd, ...(proof ? sharedWorkflowIdentity(input.session_id, role) : {
      session_id: input.session_id, agent_type: role, ...(role === "leader" ? {} : { agent_id: input.agent_id }),
    }),
    hook_event_name: post ? (input.tool_name === "Bash" ? "PostToolUseFailure" : "PostToolUse") : "PreToolUse",
    tool_name: input.tool_name, tool_input: input.tool_input,
    ...(post ? { tool_response: input.tool_response } : {}),
  };
}

/** Reuse Claude decisions; an opaque post result cannot acknowledge comments or establish a pending merge. */
export async function decideCodexHook(input, options, dependencies = {}) {
  const call = normalizeCodexHook(input, options);
  const finish = result => {
    if (options?.admission !== undefined) codexAdmissionOf(options.admission, input);
    return result;
  };
  if (call.tool_name === "apply_patch") return finish(await decideCodexEdit(call, dependencies));
  if (call.hook_event_name === "PostToolUseFailure") {
    const result = await mergeGuard(call, dependencies);
    return finish({ ...result, hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: GAP } });
  }
  const notes = [];
  for (const decide of [commandGuard, decidePr, mergeGuard]) {
    const result = (await decide(call, dependencies))?.hookSpecificOutput;
    if (result?.permissionDecision === "deny") return finish({ hookSpecificOutput: result });
    if (result?.additionalContext) notes.push(result.additionalContext);
  }
  return finish(notes.length ? { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: notes.join(" ") } } : null);
}

/** Explicit JSON denials exit zero; invalid input/evaluation errors use Codex's blocking exit two. */
export async function runCodexHook(args, { stdin = process.stdin, write = console.log, error = console.error, env = process.env, ...dependencies } = {}) {
  try {
    const configured = codexHookChannel(env, true);
    // Optional legacy role flags carry no authority on an owned channel.
    if (!(configured && args.length === 0) && (args.length !== 2 || args[0] !== "--role" || !ROLES.has(args[1]))) fail("usage: qc codex-hook [--role <role>]");
    const data = await readCodexNativeInput(stdin);
    let input;
    try { input = JSON.parse(data); } catch { fail("malformed JSON"); }
    const output = configured ? await reportCodexHook(input, { env }) : await decideCodexHook(input, { role: args[1] }, dependencies);
    if (output) write(JSON.stringify(output));
    return 0;
  } catch (cause) {
    error(`Codex hook: ${cause.message}`);
    return 2;
  }
}
