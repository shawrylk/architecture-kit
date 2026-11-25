#!/usr/bin/env node
// The context-watch trigger reminds the main session to compact at a clean break.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaults, load } from "../config.mjs";
import { writeState } from "./budget-counter.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { budgetsOf } from "./context-budgets.mjs";
import { dispatchSettings } from "./dispatch.mjs";
import { contextOf, lastUsage } from "./transcript-usage.mjs";
import { checkpointNameOf, checkpointSettingsAt } from "./checkpoint.mjs";
import { normalizeUsage } from "./codex-usage.mjs";
import { orchestratorVerdict, roleBudgetVerdict } from "./role-budget.mjs";

/** The caller supplies resolved native settings, verified events and its bounded per-role counter/state. */
export function decideCodexBudget(call, { usage, config, nativeConfig = {}, count, state = {} }) {
  const normalized = normalizeUsage(usage);
  const tokens = normalized?.sessionId === call.session_id && (call.turn_id === undefined || normalized.turnId === call.turn_id) ? normalized.tokens : undefined;
  const budgets = budgetsOf(config);
  if (["implementer", "reviewer"].includes(call.role)) {
    return roleBudgetVerdict({ role: call.role, tokens, budget: budgets[call.role], call, state });
  }
  if (call.role !== "leader" || !budgets.orchestrator || !Number.isSafeInteger(count) || count < 1) return null;
  const compactAt = Object.hasOwn(nativeConfig, "model_auto_compact_token_limit")
    ? nativeConfig.model_auto_compact_token_limit : budgets.orchestrator.compactAt;
  if (!Number.isSafeInteger(compactAt) || compactAt < 1) return null;
  const verdict = orchestratorVerdict({ tokens, compactAt, count, state });
  if (!verdict) return null;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext:
    `Context budget: about ${Math.round(tokens / 1000)}K tokens. Native automatic compaction owns the threshold (${compactAt}); ` +
    `update the checkpoint at the next clean break: ${checkpointNameOf(call.cwd, call.session_id)}. Keep the plan, open PRs, branch heads and ledger in the resume notes.` } };
}

export const START = defaults.budgets.orchestrator.compactAt;
export const STEP = 50_000;
export const TELL_USER = 300_000;

export function decide(call, { tmp = os.tmpdir() } = {}) {
  if (call.agent_id || !call.transcript_path) return null;
  let budget;
  try {
    const cwd = call.cwd ?? process.cwd();
    const config = load(checkoutRootOf(cwd) ?? cwd);
    if (dispatchSettings(config.swarm)) return null;
    budget = budgetsOf(config).orchestrator;
  } catch {
    return null;
  }
  if (!budget) return null;
  const tokens = contextOf(lastUsage(call.transcript_path));
  if (!Number.isFinite(tokens)) return null;
  const step = tokens < budget.compactAt ? -1 : Math.floor((tokens - budget.compactAt) / STEP);
  const directory = path.join(tmp, "claude-context-watch");
  const file = path.join(directory, `${String(call.session_id ?? "").replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  const lock = `${file}.lock`;
  mkdirSync(directory, { recursive: true });
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      if (Date.now() - statSync(lock).mtimeMs <= 30_000) return null;
      const stale = `${lock}.${randomUUID()}`;
      renameSync(lock, stale);
      if (Date.now() - statSync(stale).mtimeMs <= 30_000) {
        rmdirSync(stale);
        return null;
      }
      rmdirSync(stale);
    } catch (claimError) {
      if (claimError.code === "ENOENT") return null;
      throw claimError;
    }
    try {
      mkdirSync(lock);
    } catch (retryError) {
      if (retryError.code === "EEXIST") return null;
      throw retryError;
    }
  }
  let kept = -1;
  try {
    try {
      kept = JSON.parse(readFileSync(file, "utf8")).step ?? -1;
    } catch {
      // A session without readable state starts below the first step.
    }
    // Only a compaction below compactAt resets the thresholds already noted.
    if (step > kept || (step === -1 && kept !== -1)) writeState(file, { step });
  } finally {
    try {
      rmdirSync(lock);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (step <= kept) return null;
  const k = Math.round(tokens / 1000);
  const cwd = call.cwd ?? process.cwd();
  const checkpoint = checkpointSettingsAt(cwd)
    ? ` Update the checkpoint now: ${checkpointNameOf(cwd, call.session_id)}.`
    : "";
  const result = {
    hookSpecificOutput: {
      hookEventName: call.hook_event_name,
      additionalContext: `Context is about ${k}K tokens. At the next clean break (a task, review, or merge just finished, nothing mid-fix), update the resume notes and ask the user to run /compact before you continue.${checkpoint}`,
    },
  };
  if (tokens >= TELL_USER) result.systemMessage = `Context ${k}K tokens: Claude will ask you to /compact at the next clean break.`;
  return result;
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
    // Invalid hook input has no session to notify.
  }
  try {
    const result = call ? decide(call) : null;
    if (result) process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(`context-watch: ${String(error.message ?? error).replace(/[\r\n]+/g, " ")}\n`);
  }
}
