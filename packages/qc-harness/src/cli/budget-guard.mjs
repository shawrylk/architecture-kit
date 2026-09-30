#!/usr/bin/env node
// The PreToolUse trigger for the tool-call budget of swarm.md. It runs on every call of every agent,
// so it spawns no process and touches one small file. The main session has no agent id and is exempt.

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE, contextDefaults, load } from "../config.mjs";
import { budgetOf, budgetVerdict } from "./budget.mjs";
import { bumpCount, counterFileOf, readState, stateFileOf, writeState } from "./budget-counter.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { contextSettings, contextVerdict, estimateOf, handbackStamp } from "./context-signal.mjs";
import { agentTranscriptOf, contextOf, firstPromptOf, firstUsage, lastUsage } from "./transcript-usage.mjs";

const HANDBACK = "SubagentHandback";

const context = (text) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } });

/** The verdict on one tool call. @returns the hook output, or null to let the call run with no message. */
export function decide(call, tmp = os.tmpdir()) {
  const agentId = call.agent_id;
  if (typeof agentId !== "string" || agentId === "") return null;
  const root = checkoutRootOf(call.cwd ?? process.cwd());
  if (!root || !existsSync(path.join(root, CONFIG_FILE))) return null;

  let swarm;
  let budget;
  try {
    swarm = load(root).swarm;
    budget = budgetOf(swarm);
  } catch (error) {
    // A config typo must not stop every agent; the agent sees the error and reports it.
    return context(`Tool-call budget is off: ${error.message}`);
  }
  let count;
  try {
    count = bumpCount(counterFileOf(call.session_id ?? "session", agentId, tmp));
  } catch {
    // A busy or read-only temp folder is the hook's own problem, never a reason to stop the agent.
    return null;
  }
  const verdict = budgetVerdict({ count, budget, call });
  if (verdict?.hookSpecificOutput?.permissionDecision === "deny") return verdict;
  return withSignal(verdict, contextSignal(call, { swarm, count, budget, tmp }), call);
}

/** The one note for an agent whose hook input names no transcript, and the state that keeps later calls quiet. */
function noTranscriptNote(file, state) {
  writeState(file, { ...state, noTranscript: true });
  return { note: "Context signal is off for this agent: the hook input names no transcript for it." };
}

/** What the context signal adds to this call: `{ note }`, `{ stamp }`, or null. It never throws. */
function contextSignal(call, { swarm, count, budget, tmp }) {
  let settings;
  try {
    settings = contextSettings(swarm);
  } catch (error) {
    return count % contextDefaults.every === 0 ? { note: `Context signal is off: ${error.message}` } : null;
  }
  if (!settings) return null;
  const handback = call.tool_name === HANDBACK;
  if (!handback && count % settings.every !== 0) return null;
  try {
    const transcript = agentTranscriptOf(call);
    const file = stateFileOf(call.session_id ?? "session", call.agent_id, tmp);
    const state = readState(file);
    if (!transcript) return handback || state.noTranscript ? null : noTranscriptNote(file, state);
    const first = state.first > 0 ? state.first : contextOf(firstUsage(transcript));
    if (!(first > 0)) return null;
    const estimate = "estimate" in state ? state.estimate : estimateOf(firstPromptOf(transcript));
    const latest = contextOf(lastUsage(transcript));
    const next = { ...state, first, estimate };
    let signal = null;
    if (handback) {
      const stamp = handbackStamp({ context: latest, first }, settings);
      signal = stamp ? { stamp } : null;
    } else {
      const fired = state.fired ?? null;
      const verdict = contextVerdict({ context: latest, first, count, budget, estimate, agentType: call.agent_type, fired }, settings);
      if (verdict) {
        next.fired = { level: verdict.level, at: count };
        signal = { note: verdict.text };
      }
    }
    if (state.first !== first || state.estimate !== estimate || next.fired !== state.fired) writeState(file, next);
    return signal;
  } catch {
    // An unreadable transcript or a busy temp folder is the hook's own problem, never the agent's.
    return null;
  }
}

/** The budget verdict with the signal added: the note joins its context, and a stamp rewrites the hand-back. */
function withSignal(verdict, signal, call) {
  if (!signal) return verdict;
  if (signal.stamp) {
    const input = call.tool_input ?? {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...input, message: `${String(input.message ?? "")}

${signal.stamp}` },
      },
    };
  }
  const existing = verdict?.hookSpecificOutput?.additionalContext;
  return context(existing ? `${existing}
${signal.note}` : signal.note);
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const isEntryPoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntryPoint) {
  let call = null;
  try {
    call = JSON.parse(await readStdin());
  } catch {
    // Not hook input, so there is nothing to count.
  }
  const output = call ? decide(call) : null;
  if (output) process.stdout.write(JSON.stringify(output));
}
