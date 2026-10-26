// The branch that resolves an agent's role and closes work calls at its context budget.
import { HANDOFF_STEPS, isHandoffCall } from "./budget.mjs";
import { contextDefaults } from "../config.mjs";
import { reviewSettings } from "./workflow-settings.mjs";

// This branch returns the orchestrator's compaction note at each reminder interval.
export function orchestratorVerdict({ tokens, compactAt, count, state }) {
  if (count % contextDefaults.every !== 0 || !(tokens >= compactAt)) return null;
  if (state.budgetFiredAt !== undefined && count - state.budgetFiredAt < contextDefaults.repeatEvery) return null;
  state.budgetFiredAt = count;
  return `Context budget: this session sends about ${Math.round(tokens / 1000)}K tokens per call, past budgets.orchestrator.compactAt (${compactAt}). ` +
    "Run /compact at the next green step. Keep the plan path, the open PR numbers, each branch and its head, and the ledger path in the summary.";
}

export function budgetRoleOf(agentType, swarm) {
  const settings = reviewSettings(swarm);
  if (!settings) return null;
  if (settings.implementerTypes.includes(agentType)) return "implementer";
  if (Object.values(settings.reviewerTypes).some((types) => types.includes(agentType))) return "reviewer";
  return null;
}

export function roleBudgetVerdict({ role, tokens, budget, call, state }) {
  if (!budget) return null;
  if (state.budgetClosed || tokens >= budget.handoffAt) {
    state.budgetClosed = true;
    if (isHandoffCall(call)) return null;
    const steps = role === "reviewer"
      ? "Send the verdict report now. Open with `VERDICT:` for the work you reviewed, then add a line " +
        "`UNREVIEWED:` listing the files left. The controller sends a fresh reviewer with `Scope:` for those files."
      : HANDOFF_STEPS;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `Context budget spent: budgets.${role}.handoffAt (${budget.handoffAt}) in qc.config.json. Only the hand-off can run now. ${steps}`,
      },
    };
  }
  if (!(tokens >= budget.remindAt) || state.budgetReminded) return null;
  state.budgetReminded = true;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        `Context budget: this agent's calls send about ${Math.round(tokens / 1000)}K tokens, past budgets.${role}.remindAt (${budget.remindAt}). ` +
        `Finish the current item, commit and push green work, and plan the hand-off. At ${budget.handoffAt}, only the hand-off can run.`,
    },
  };
}
