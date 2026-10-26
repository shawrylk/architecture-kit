// The branch that resolves an agent's role and closes work calls at its context budget.
import { HANDOFF_STEPS, isHandoffCall } from "./budget.mjs";
import { reviewSettings } from "./workflow-settings.mjs";

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
