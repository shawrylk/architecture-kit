// A branch that judges the newest run of each check suite and name.

const GREEN = new Set(["success", "neutral", "skipped"]);

export function checkVerdict(entry) {
  if (entry.__typename === "StatusContext" || entry.context !== undefined) {
    const state = entry.state?.toLowerCase();
    if (state === "pending" || state === "expected") return "pending";
    return GREEN.has(state) ? "passed" : "failed";
  }
  const status = entry.status?.toLowerCase();
  if (status !== "completed") return status === "queued" ? "queued" : "pending";
  return GREEN.has(entry.conclusion?.toLowerCase()) ? "passed" : "failed";
}

export function pendingCiReason(names, workflowRuns = [], requiredChecks = []) {
  const open = workflowRuns.find((run) => run.status !== "completed");
  if (open) return `${open.name ?? "workflow"} is ${open.status}`;
  const present = new Set(names);
  const missing = requiredChecks.find((name) => !present.has(name));
  return missing === undefined ? null : `${missing} is missing`;
}

export function checkRunsState(runs, { workflowRuns = [], requiredChecks = [] } = {}) {
  const newestByCheck = new Map();
  for (const entry of runs) {
    const key = JSON.stringify([entry.check_suite?.id, entry.name]);
    const current = newestByCheck.get(key);
    const newer = current && entry.started_at && current.started_at && entry.started_at !== current.started_at
      ? entry.started_at > current.started_at
      : entry.id > (current?.id ?? -1);
    if (!current || newer) {
      newestByCheck.set(key, entry);
    }
  }
  const newest = [...newestByCheck.values()];
  const failed = newest.find((entry) => checkVerdict(entry) === "failed");
  if (failed) return { reason: `${failed.name} ended ${failed.conclusion}`, pending: false };
  const open = newest.find((entry) => ["pending", "queued"].includes(checkVerdict(entry)));
  const reason = open ? `${open.name} is ${open.status}` : pendingCiReason(newest.map((entry) => entry.name), workflowRuns, requiredChecks);
  return { reason, pending: reason !== null };
}
