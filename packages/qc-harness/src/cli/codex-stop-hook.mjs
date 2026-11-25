// Wire: openai/codex rust-v0.172.0 hooks/src/{schema.rs,events/stop.rs}; core/src/session/turn.rs.
import { codexHookChannel, readCodexNativeInput } from "./codex-hook-channel.mjs";
import { realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkoutRootOf } from "./checkout-root.mjs";
import { decide as issueGate } from "./issue-gate.mjs";
import { decide as worktreeGate } from "./worktree-gate.mjs";

const hook = fileURLToPath(new URL("../../../../hooks/stop-gate.sh", import.meta.url));
const text = value => typeof value === "string" && value.trim().length > 0;
const fail = reason => { throw new Error(`Codex Stop: ${reason}`); };

/** Root Stop has no native agent identity. SubagentStop and external worker stops need their own bridge. */
export function normalizeCodexStop(input, { role } = {}) {
  if (!input || Array.isArray(input) || input.hook_event_name !== "Stop") fail("expected root Stop; SubagentStop unsupported");
  if (role !== "leader") fail("explicit leader role required; worker stops unsupported");
  if (input.agent_id !== undefined || input.agent_type !== undefined) fail("root Stop conflicts with worker identity");
  if (!text(input.session_id) || !text(input.turn_id)) fail("missing stable session/turn identity");
  if (typeof input.stop_hook_active !== "boolean") fail("Stop requires a boolean stop_hook_active");
  if (!text(input.cwd) || !path.isAbsolute(input.cwd)) fail("working directory must be absolute and local");
  let cwd;
  try {
    cwd = realpathSync(input.cwd);
    if (!statSync(cwd).isDirectory()) fail("working directory is not a directory");
  } catch { fail("working directory cannot be read as a directory"); }
  return { hook_event_name: "Stop", cwd: checkoutRootOf(cwd) ?? cwd, session_id: input.session_id,
    stop_hook_active: input.stop_hook_active, agent_type: role };
}

/** Run the unchanged shell and shared decisions, including every note and session-ledger side effect. */
export async function runCodexStopHook(raw, { role, run = spawnSync, env = process.env,
  issue = issueGate, worktree = worktreeGate, ...dependencies } = {}) {
  try {
    let input;
    try { input = JSON.parse(raw); } catch { fail("malformed JSON"); }
    const call = normalizeCodexStop(input, { role });
    const result = run("bash", [hook], { cwd: call.cwd, input: JSON.stringify(call), encoding: "utf8",
      env: { ...env, CLAUDE_PROJECT_DIR: call.cwd, CLAUDE_PLUGIN_ROOT: path.dirname(path.dirname(hook)) },
      timeout: 120_000, maxBuffer: 8 << 20, windowsHide: true });
    if (result.error) throw result.error;
    if (![0, 2].includes(result.status)) fail(`stop-gate failed (${result.signal ?? result.status}): ${result.stderr ?? ""}`);
    const outputs = [];
    if (result.status === 2) {
      if (!text(result.stderr)) fail("stop-gate failed without a refusal reason");
      outputs.push({ decision: "block", reason: result.stderr });
    } else if (result.stdout?.trim()) {
      const output = JSON.parse(result.stdout);
      if (!output || typeof output !== "object" || Array.isArray(output)) fail("invalid stop-gate JSON");
      outputs.push(output);
    }
    outputs.push(await issue(call, dependencies), await worktree(call, { ...dependencies, projectDir: call.cwd }));
    const reasons = outputs.filter(output => output?.decision === "block").map(output => output.reason);
    const notes = outputs.map(output => output?.systemMessage).filter(Boolean);
    return { code: 0, stdout: JSON.stringify({ ...(reasons.length ? { decision: "block", reason: reasons.join("\n") } : {}),
      ...(notes.length ? { systemMessage: notes.join("\n") } : {}) }), stderr: "" };
  } catch (cause) {
    return { code: 2, stdout: "", stderr: `Codex Stop: ${cause.message}` };
  }
}

export async function runCodexStopHookCli(args, { stdin = process.stdin, write = console.log, error = console.error, ...dependencies } = {}) {
  if (args.length !== 2 || args[0] !== "--role" || args[1] !== "leader") {
    error("Codex Stop: usage: qc codex-stop-hook --role leader (worker/SubagentStop unsupported)"); return 2;
  }
  try {
    codexHookChannel(dependencies.env ?? process.env);
    const raw = await readCodexNativeInput(stdin);
    const result = await runCodexStopHook(raw, { ...dependencies, role: args[1] });
    if (result.stdout) write(result.stdout);
    if (result.stderr) error(result.stderr);
    return result.code;
  } catch (cause) { error(`Codex Stop: ${cause.message}`); return 2; }
}
