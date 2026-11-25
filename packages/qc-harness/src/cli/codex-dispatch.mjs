import { codexRoleProfile, scoutReportProblem } from "./codex-role-profile.mjs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dispatchDefaults, reviewDefaults } from "../config.mjs";
import { branchAt } from "./git-read.mjs";
import { checkpointRefusal } from "./checkpoint.mjs";
import { dispatchNote, dispatchRefusal, dispatchSettingsAt } from "./dispatch.mjs";
import { routeRefusal } from "./dispatch-route.mjs";
import { limitFileOf, readLimit } from "./codex-limit.mjs";
import { claimSlot, slotDirOf } from "./dispatch-slot.mjs";
import { judgeTask, recordDispatch } from "./task-gate.mjs";
import { decide as reportDecision } from "./report-stop.mjs";
import { decide as planDecision } from "./plan-stop.mjs";
import { decide as costDecision } from "./cost-stop.mjs";
import { workflowAt } from "./workflow-settings.mjs";
import { appendRecord, readLedger } from "./ledger.mjs";

const fail = reason => { throw new Error(reason || "Codex worker lifecycle unavailable"); };
const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const workers = new WeakMap();
export function normalizeCodexWorker(input) {
  if (!input || input.role === "leader" || !codexRoleProfile(input.role) || ![input.parentSessionId, input.workerSessionId].every(id) ||
      !["worktree", "branch", "brief", "model"].every(key => typeof input[key] === "string" && input[key].length > 0 &&
        input[key].length <= 4096 && !/[\r\n]/.test(input[key])) || !path.isAbsolute(input.worktree) || !path.isAbsolute(input.brief) ||
      typeof input.report !== "string" || Buffer.byteLength(input.report) > 262144) fail();
  return Object.freeze({ session_id: input.parentSessionId, agent_id: input.workerSessionId, agent_type: input.role, cwd: input.worktree });
}
const check = output => {
  const reason = output?.hookSpecificOutput?.permissionDecisionReason ?? output?.reason ??
    output?.systemMessage ?? output?.hookSpecificOutput?.additionalContext;
  if (reason) fail(reason);
};

/** Runner-private callbacks, never a native hook payload or a worker-accessible registration API.
 * H owns launch/IPC/pinning. The returned child must be the reservation's owned child.
 * No new native payload: original native envelopes go only to the approved runtime boundary.
 */
export function createCodexDispatch(input, { runtime, tmp = os.tmpdir(), reads = {} } = {}) {
  input = Object.freeze({ ...input });
  const profile = codexRoleProfile(input.role);
  const identity = normalizeCodexWorker(input), workflow = workflowAt(input.worktree), review = workflow?.review ?? reviewDefaults;
  const type = (profile.route === "implementer" ? workflow?.review.implementerTypes ?? dispatchDefaults.implementerTypes :
    profile.route === "planner" ? review.plannerTypes : review.reviewerTypes[input.role === "reviewer" ? "task" : "branch"])[0];
  if (!type) fail();
  const call = { ...identity, agent_type: type }, dir = slotDirOf(call.session_id, tmp);
  const prompt = `Brief: ${input.brief}\nWorktree: ${input.worktree}\nBranch: ${input.branch}`;
  let state = "new", handle, child, projection, report = null, result, outcome, ending, claimed = false, spawnFailed = false;
  const holder = randomUUID();
  const dead = () => !child || spawnFailed || child.exitCode !== null && child.exitCode !== undefined || child?.signalCode != null;
  const stopCall = event => ({ ...call, hook_event_name: event, agent_transcript_path: projection && path.join(projection, "brief.jsonl"),
    tool_name: "SubagentHandback", tool_input: { message: report }, last_assistant_message: report });
  const policyUnchanged = () => {
    try {
      if (isDeepStrictEqual(workflowAt(input.worktree), workflow)) return;
    } catch { /* Unavailable policy fails closed without exposing config contents. */ }
    fail("Workflow policy changed during worker lifecycle");
  };
  const validateReport = () => {
    policyUnchanged();
    if (input.role === "scout") {
      const problem = scoutReportProblem(report);
      if (problem) fail(problem);
      return;
    }
    if (input.role === "tests") return; // Acceptance belongs to the original tests runner, never RED/GREEN or verdict claims.
    check(reportDecision(stopCall("PreToolUse"), tmp)); check(planDecision(stopCall("PreToolUse"), tmp));
  };
  const admitted = native => {
    if (state !== "running") fail();
    const proof = runtime.validate(handle, native);
    if (!proof || proof.role !== profile.runtime ||
        proof.worktree !== input.worktree || proof.workflowParentId !== input.parentSessionId) fail();
    return proof;
  };
  async function terminate() {
    if (dead()) return;
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); child.off("exit", done); child.off("error", error); };
      const done = () => { cleanup(); resolve(); };
      const error = () => { if (!child.pid) done(); };
      const timer = setTimeout(() => { cleanup(); reject(Error("Owned child termination unconfirmed")); }, 1000);
      child.once("exit", done); child.on("error", error);
      try { if (!child.kill("SIGTERM")) { cleanup(); reject(Error("Owned child termination unconfirmed")); } }
      catch { cleanup(); reject(Error("Owned child termination unconfirmed")); }
    });
    if (!dead() && child.pid) fail("Owned child termination unconfirmed");
  }
  async function terminal(kind) {
    if (result) return result;
    if (ending) return ending;
    state = "ending";
    ending = (async () => {
      if (kind === "finish" && !dead()) fail("Worker exit has not been observed");
      if (kind !== "finish") await terminate();
      let accepted = kind === "finish" && child?.exitCode === 0 && report !== null;
      const notes = [];
      try {
        if (accepted && !outcome) {
          validateReport();
          if (["scout", "tests"].includes(input.role)) {
            if (!workflow) fail("Worker workflow unavailable");
            appendRecord(workflow.ledger, { type: "stop", session: call.session_id, agentType: type,
              agentId: call.agent_id, role: input.role });
          } else {
            check(reportDecision(stopCall("SubagentStop"), tmp));
            check(planDecision(stopCall("SubagentStop"), tmp));
          }
        }
      } catch (error) { accepted = false; notes.push(error.message); }
      // The runner projection contains no native usage. Shared cost stays unknown, never fabricated zero.
      if (!outcome) costDecision(stopCall("SubagentStop"), tmp);
      outcome ??= Object.freeze({ accepted, notes });
      if (handle) { try { runtime.terminal(handle); } catch { /* Runtime may already have retired on exit. */ } }
      if (claimed) for (const name of readdirSync(dir)) {
        if (/^slot-\d+\.claim$/.test(name) && readFileSync(path.join(dir, name), "utf8") === `pending:${holder}`) rmSync(path.join(dir, name), { force: true });
      }
      if (projection) rmSync(projection, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      state = "terminal";
      return result = outcome;
    })();
    try { return await ending; } catch (error) { ending = null; throw error; }
  }
  return Object.freeze({
    async start(launch) {
      if (state !== "new") fail();
      state = "starting";
      try {
        policyUnchanged();
        if (branchAt(input.worktree) !== input.branch) fail("Worker branch mismatch");
        const checkpoint = checkpointRefusal({ cwd: call.cwd, session_id: call.session_id });
        if (checkpoint) fail(checkpoint);
        const settings = dispatchSettingsAt(call.cwd, "codex"), notes = [];
        const taskInput = { subagent_type: type, model: input.model, prompt };
        if (settings) {
          const external = { ...taskInput, subagent_type: "codex" };
          const refusal = dispatchRefusal(taskInput, settings) ?? dispatchRefusal(external, settings) ??
            routeRefusal(external, settings, readLimit(limitFileOf(process.env, tmp)));
          if (refusal) fail(refusal);
          notes.push(dispatchNote(taskInput, settings));
        }
        if (workflow && readLedger(workflow.ledger).some(r => r.type === "stop" && r.session === call.session_id && r.agentId === call.agent_id)) fail("Worker identity already completed");
        const task = judgeTask({ cwd: call.cwd, session_id: call.session_id, tool_input: taskInput }, tmp, reads);
        if (task.refusal) fail(task.refusal);
        const used = workers.get(runtime) ?? new Set(), key = `${call.session_id}:${call.agent_id}`;
        if (used.has(key) || used.size >= 256) fail("Worker identity already admitted or capacity exhausted");
        used.add(key); workers.set(runtime, used);
        if (settings && profile.route === "implementer") {
          if (claimSlot(dir, settings, Date.now(), holder)) fail("Worker slot occupied");
          claimed = true;
        }
        notes.push(recordDispatch(task));
        // Trusted workflow projection for shared placement only; never pass a Codex rollout to Claude parsers.
        projection = mkdtempSync(path.join(tmp, "codex-worker-"));
        writeFileSync(path.join(projection, "brief.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");
        handle = runtime.reserve({ role: profile.runtime, workflowParentId: input.parentSessionId });
        child = await launch(handle, prompt);
        child.once("error", () => { if (!child.pid) spawnFailed = true; });
        const proof = await runtime.ready(handle);
        if (proof.pid !== child.pid) fail("Owned child identity mismatch");
        state = "running";
        admitted({ session_id: proof.nativeThreadId, cwd: input.worktree });
        return { proof, notes: notes.filter(Boolean) };
      } catch (error) { await terminal("error"); throw error; }
    },
    handback(native, text) {
      admitted(native);
      if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > 262144) fail();
      report = text;
      try { validateReport(); } catch (error) { report = null; throw error; }
      return true;
    },
    async context(native) { admitted(native); return runtime.context(handle, native); },
    finish: () => terminal("finish"),
    error: () => terminal("error"),
    cancel: () => terminal("cancel"),
  });
}
