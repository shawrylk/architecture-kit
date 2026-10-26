import { checkoutRootOf } from "./checkout-root.mjs";
import { budgetsOf } from "./context-budgets.mjs";
import { latestCosts, ledgerFileOf, readLedger } from "./ledger.mjs";

export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * p / 100) - 1];
}

const size = (n) => `${Math.round(n / 1000)}K`;

export function budgetReport(records, budgets) {
  const costs = latestCosts(records);
  const withContext = costs.filter((record) => Number.isFinite(record.endContext));
  const lines = [];
  for (const role of ["implementer", "reviewer"]) {
    const budget = budgets[role];
    if (budget == null) continue;
    const tasks = withContext.filter((record) => record.role === role || (role === "reviewer" && record.role === "branch-reviewer"));
    if (tasks.length === 0) {
      lines.push(`${role}: no cost record with context figures`);
      continue;
    }
    const contexts = tasks.map((record) => record.endContext);
    const median = percentile(contexts, 50);
    const p90 = percentile(contexts, 90);
    const hits = tasks.filter((record) => record.peakContext >= budget.handoffAt).length;
    const advice = hits / tasks.length > 0.1
      ? "raise handoffAt: more than 10% of tasks hand off"
      : p90 < budget.handoffAt / 2
        ? "lower handoffAt: the 90th percentile is under half of it"
        : "keep handoffAt";
    lines.push(
      `${role}: tasks ${tasks.length}  median ${size(median)}  p90 ${size(p90)}  handoffAt ${size(budget.handoffAt)}  ` +
      `hit handoffAt ${hits} of ${tasks.length} (${Math.round(hits / tasks.length * 100)}%); ${advice}`,
    );
  }
  const skipped = costs.length - withContext.length;
  if (skipped > 0) lines.push(`skipped ${skipped} cost records with no context figure`);
  lines.push("orchestrator and Codex: no cost record.");
  return lines;
}

export function runBudget(config, args = []) {
  if (args.length !== 1 || args[0] !== "report") {
    console.error("Usage: qc budget report");
    return 1;
  }
  const root = checkoutRootOf(config.root ?? process.cwd());
  const file = root ? ledgerFileOf(root) : null;
  if (!file) {
    console.error("qc budget report: this folder is in no git checkout.");
    return 1;
  }
  let budgets;
  try {
    budgets = budgetsOf(config);
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  for (const line of budgetReport(readLedger(file), budgets)) console.log(line);
  return 0;
}
