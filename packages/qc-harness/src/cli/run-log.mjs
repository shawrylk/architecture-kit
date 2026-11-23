import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { redactOutput } from "./output-redaction.mjs";
import { commonDirOf } from "./ledger.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";

export const RUN_ROLES = ["scout", "tests", "implement", "review", "fix"];
export const RUN_FIELDS = Object.freeze([
  "kind", "time", "branch", "issue", "role", "effort", "exit", "refusal", "inputTokens",
  "outputTokens", "minutes", "verify", "live", "verdict", "findings", "pr", "run", "head", "result",
]);

/** @returns the local run log shared by this checkout's worktrees, or null outside git. */
export function runLogFileOf(cwd) {
  const root = checkoutRootOf(cwd);
  const common = root && commonDirOf(root);
  return common ? path.join(common, "qc", "runs.jsonl") : null;
}

/** Append one complete JSON line; the caller owns warnings and exit policy. */
export function appendRun(file, record) {
  if (!file) throw new Error("cannot find the git common directory");
  record = Object.fromEntries(Object.entries(record).filter(([field]) => RUN_FIELDS.includes(field)));
  const allowedBranch = (value) => value.length <= 100 &&
    /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.exec(value)?.[0] === value;
  for (const field of ["branch", "pr", "run", "head"]) {
    if (!Object.hasOwn(record, field)) continue;
    const value = record[field];
    let allowed = false;
    if (field === "pr") {
      allowed = Number.isSafeInteger(value) && value > 0;
    } else if (typeof value === "string" && redactOutput(value) === value) {
      if (field === "head") allowed = /^[0-9a-f]{7,40}$/.exec(value)?.[0] === value;
      else if (field === "branch") allowed = allowedBranch(value);
      else {
        const [workflow, branch, sha, ...extra] = value.split("@");
        allowed = /^[A-Za-z0-9_-]+\.ya?ml$/.exec(workflow)?.[0] === workflow &&
          branch !== undefined && allowedBranch(branch) && extra.length === 0 &&
          (sha === undefined || /^[0-9a-f]{7,40}$/.exec(sha)?.[0] === sha);
      }
    }
    if (!allowed) record[field] = "[REDACTED]";
  }
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}

const valid = (row) => row && !Array.isArray(row) && Number.isFinite(Date.parse(row.time)) && (
  row.kind === "codex" ? RUN_ROLES.includes(row.role) && Number.isInteger(row.exit) && row.exit >= 0 &&
    (row.inputTokens === undefined || Number.isFinite(row.inputTokens) && row.inputTokens >= 0) :
  row.kind === "ci" && ["pass", "fail"].includes(row.result) && Number.isFinite(row.minutes) && row.minutes >= 0
);

/** Missing logs are empty; malformed lines are counted and other read errors propagate. */
export function readRuns(file) {
  let text;
  try { text = file ? readFileSync(file, "utf8") : ""; }
  catch (error) {
    if (error.code === "ENOENT") return { runs: [], skipped: 0 };
    throw error;
  }
  const runs = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!valid(row)) throw new Error("invalid run");
      runs.push(row);
    } catch { skipped += 1; }
  }
  return { runs, skipped };
}
