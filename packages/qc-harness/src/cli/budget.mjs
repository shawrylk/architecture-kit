// The branch that turns an agent's tool-call count into a verdict: nothing, a reminder, or a deny.
// An agent does not count its own calls, and each call re-sends its whole transcript, so the hook
// counts for it and closes every tool except the hand-off once the budget is spent.

import { defaults } from "../config.mjs";
import { gitCall, isReadOnly, segmentsOf, writesRedirect } from "./shell-command.mjs";

export const DEFAULT_BUDGET = defaults.swarm.toolCallBudget;
const REMIND_PERCENT = 70;
const REMIND_EVERY = 10;
const KEY = "swarm.toolCallBudget";
const HANDOFF_GIT = new Set(["status", "diff", "log", "add", "commit", "push"]);

/** @returns the budget from the `swarm` config section, or throws naming the key a repository got wrong. */
export function budgetOf(swarm = {}) {
  const budget = swarm.toolCallBudget ?? DEFAULT_BUDGET;
  if (!Number.isInteger(budget) || budget < 1) {
    throw new Error(`${KEY} in qc.config.json must be a positive whole number, got ${JSON.stringify(swarm.toolCallBudget)}`);
  }
  return budget;
}

const isHandoffSegment = (segment) =>
  isReadOnly(segment) || (!writesRedirect(segment) && HANDOFF_GIT.has(gitCall(segment)?.sub));

/** True for a call the hand-off needs: read, commit and push, write the note, send the report. */
export function isHandoffCall(call) {
  const input = call.tool_input ?? {};
  switch (call.tool_name) {
    case "Read":
    case "SubagentHandback":
      return true;
    case "Write":
    case "Edit":
      return String(input.file_path ?? "").replaceAll("\\", "/").includes("/handoffs/");
    case "Bash": {
      const segments = segmentsOf(String(input.command ?? ""));
      return segments.length > 0 && segments.every(isHandoffSegment);
    }
    default:
      return false;
  }
}

const remind = (count, budget) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext:
      `Tool-call budget: this is call ${count} of ${budget}. Finish the current step, commit and push green work, ` +
      `and plan the hand-off. At call ${budget}, only the hand-off can run.`,
  },
});

const deny = (count, budget) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason:
      `Tool-call budget spent: this is call ${count} of ${budget} (${KEY} in qc.config.json). ` +
      "Only the hand-off can run now. " +
      "1. Commit and push green work with git add, git commit and git push. " +
      "2. Write the hand-off note to a path under /handoffs/: what is done, what is left in order, and the exact next step. " +
      "3. Send the final report, and name the note. " +
      "Read and read-only commands still run.",
  },
});

/** @returns the hook output for the call numbered `count`, or null to let it run with no message. */
export function budgetVerdict({ count, budget, call }) {
  if (count >= budget) return isHandoffCall(call) ? null : deny(count, budget);
  const remindAt = Math.ceil((budget * REMIND_PERCENT) / 100);
  if (count >= remindAt && (count - remindAt) % REMIND_EVERY === 0) return remind(count, budget);
  return null;
}
