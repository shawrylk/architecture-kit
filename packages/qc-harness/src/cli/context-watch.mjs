#!/usr/bin/env node
// The context-watch trigger reminds the main session to compact at a clean break.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaults, hasExplicitOrchestratorCompactAt, load } from "../config.mjs";
import { writeState } from "./budget-counter.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { budgetsOf } from "./context-budgets.mjs";
import { dispatchSettings } from "./dispatch.mjs";
import { contextOf, lastUsage } from "./transcript-usage.mjs";
import { checkpointNameOf, checkpointSettingsAt } from "./checkpoint.mjs";

export const START = defaults.budgets.orchestrator.compactAt;
export const STEP = 50_000;
export const TELL_USER = 300_000;

function compactPoint(root) {
  const globalDirectory = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  let window;
  for (const file of [
    path.join(globalDirectory, "settings.json"),
    path.join(root, ".claude", "settings.json"),
    path.join(root, ".claude", "settings.local.json"),
  ]) {
    try {
      const value = JSON.parse(readFileSync(file, "utf8"))?.autoCompactWindow;
      if (typeof value === "number" && Number.isFinite(value) && value > 0) window = value;
    } catch {
      // Each missing, malformed, or unreadable source leaves earlier settings intact.
    }
  }
  return window === undefined ? START : window * 0.8;
}

export function decide(call, { tmp = os.tmpdir() } = {}) {
  if (call.agent_id || !call.transcript_path) return null;
  let compactAt;
  try {
    const cwd = call.cwd ?? process.cwd();
    const root = checkoutRootOf(cwd) ?? cwd;
    const config = load(root);
    if (dispatchSettings(config.swarm)) return null;
    const budget = budgetsOf(config).orchestrator;
    if (!budget) return null;
    compactAt = hasExplicitOrchestratorCompactAt(config) ? budget.compactAt : compactPoint(root);
  } catch {
    return null;
  }
  const tokens = contextOf(lastUsage(call.transcript_path));
  if (!Number.isFinite(tokens)) return null;
  const step = tokens < compactAt ? -1 : Math.floor((tokens - compactAt) / STEP);
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
