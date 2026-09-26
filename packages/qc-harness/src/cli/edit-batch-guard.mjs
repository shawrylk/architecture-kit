#!/usr/bin/env node
// The trigger for swarm.md's one edit per file per parallel block. PreToolUse claims the file for the
// batch and denies a second claim. PostToolBatch ends the batch, and a claim expires as a last resort.

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE } from "../config.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { batchDirOf, claimPath, endBatch, isBatchAware, releasePath } from "./edit-batch-state.mjs";

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
export const CLAIM_TTL_MS = 60_000;

/** One file as one key: absolute, forward slashes, and lowercase on Windows. */
export function pathKey(file, cwd, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const slashed = paths.resolve(cwd, file).split(paths.sep).join("/");
  return platform === "win32" ? slashed.toLowerCase() : slashed;
}

const deny = (file) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason:
      `Edit batch guard: one edit per file per parallel block: send it after this result. Another edit ` +
      `of ${file} is in this block, and two edits of one file race and lose all but the last.`,
  },
});

/** The verdict on one hook event. @returns the hook output, or null to let the call run with no message. */
export function decide(call, tmp = os.tmpdir(), now = Date.now()) {
  const agentKey = typeof call.agent_id === "string" && call.agent_id !== "" ? call.agent_id : "main";
  const dir = batchDirOf(call.session_id ?? "session", agentKey, tmp);
  try {
    if (call.hook_event_name === "PostToolBatch") {
      endBatch(dir);
      return null;
    }
    const file = call.tool_input?.file_path;
    if (!EDIT_TOOLS.has(call.tool_name) || typeof file !== "string" || file === "") return null;
    const key = pathKey(file, call.cwd ?? process.cwd());
    if (call.hook_event_name === "PostToolUse") {
      // A client with no batch event ends the claim with the result, so a later edit is never refused.
      if (!isBatchAware(dir)) releasePath(dir, key);
      return null;
    }
    if (call.hook_event_name !== "PreToolUse") return null;
    const root = checkoutRootOf(path.dirname(path.resolve(call.cwd ?? process.cwd(), file)));
    if (!root || !existsSync(path.join(root, CONFIG_FILE))) return null;
    return claimPath(dir, key, now, CLAIM_TTL_MS) ? null : deny(file);
  } catch {
    // A busy or read-only temp folder is the hook's own problem, never a reason to refuse an edit.
    return null;
  }
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
    // Not hook input, so there is nothing to judge.
  }
  const output = call ? decide(call) : null;
  if (output) process.stdout.write(JSON.stringify(output));
}
