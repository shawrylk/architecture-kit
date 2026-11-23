import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { redactOutput } from "./output-redaction.mjs";
import { commonDirOf } from "./ledger.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";

export const RUN_ROLES = ["scout", "tests", "implement", "review", "fix"];

/** @returns the local run log shared by this checkout's worktrees, or null outside git. */
export function runLogFileOf(cwd) {
  const root = checkoutRootOf(cwd);
  const common = root && commonDirOf(root);
  return common ? path.join(common, "qc", "runs.jsonl") : null;
}

/** Append one complete JSON line; the caller owns warnings and exit policy. */
export function appendRun(file, record) {
  if (!file) throw new Error("cannot find the git common directory");
  record = { ...record };
  for (const field of ["branch", "pr", "run"]) {
    const value = record[field];
    if (typeof value !== "string") continue;
    const cleaned = redactOutput(value)
      .replace(/(?:[a-z]+:\/\/|\\\\)[^\s"'`]+/gi, "[REDACTED]");
    const target = field === "run" ? value.slice(value.indexOf("@") + 1) : value;
    const checked = target.split(os.hostname()).join("[REDACTED]")
      .replace(/(?:[a-z]+:\/\/|\\\\)[^\s"'`]+/gi, "[REDACTED]")
      .replace(/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi, "[REDACTED]")
      .replace(/(?:\d{1,3}\.){3}\d{1,3}/g, "[REDACTED]")
      .replace(/[a-f0-9]*:[a-f0-9]*:[a-f0-9:]*/gi, "[REDACTED]");
    if (cleaned !== value || checked !== target) record[field] = "[REDACTED]";
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
