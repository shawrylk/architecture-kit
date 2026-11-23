import { readRuns, RUN_ROLES, runLogFileOf } from "./run-log.mjs";

const DAY = 86_400_000;
const mean = (rows, field) => rows.length ? rows.reduce((sum, row) => sum + (row[field] ?? 0), 0) / rows.length : null;
const rate = (rows, predicate) => rows.length ? rows.filter(predicate).length / rows.length * 100 : null;
const number = (value) => value.toFixed(1).replace(/\.0$/, "");
const delta = (current, previous, digits = 1, suffix = "") => current === null || previous === null ? "n/a" : `${current - previous >= 0 ? "+" : ""}${(current - previous).toFixed(digits)}${suffix}`;
const top = (rows, key) => {
  const counts = new Map();
  for (const row of rows) {
    const value = key(row);
    if (value !== null && value !== undefined && value !== "") counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, 3);
};

/** Summarize the local run log; no configuration or network service is needed. */
export function runMetrics(argv, { cwd = process.cwd(), now = Date.now, say = console.log, warn = console.error } = {}) {
  try {
    const end = now();
    let since = end - 7 * DAY;
    if (argv.length) {
      if (argv.length !== 2 || argv[0] !== "--since" || !/^\d{4}-\d{2}-\d{2}$/.test(argv[1])) throw new Error("usage: qc metrics [--since <YYYY-MM-DD>]");
      since = Date.parse(`${argv[1]}T00:00:00.000Z`);
      if (!Number.isFinite(since) || new Date(since).toISOString().slice(0, 10) !== argv[1] || since >= end) throw new Error("--since must be a real date before now");
    }
    const { runs, skipped } = readRuns(runLogFileOf(cwd));
    const current = runs.filter((row) => Date.parse(row.time) >= since && Date.parse(row.time) <= end);
    const previous = runs.filter((row) => Date.parse(row.time) >= since - (end - since) && Date.parse(row.time) < since);
    if (!current.length) say("no runs recorded");
    for (const role of RUN_ROLES) {
      const rows = current.filter((row) => row.kind === "codex" && row.role === role);
      if (!rows.length) continue;
      const before = previous.filter((row) => row.kind === "codex" && row.role === role);
      const exited = (code) => (row) => row.exit === code;
      const success = rate(rows, exited(0));
      const refusal = rate(rows, exited(4));
      const input = mean(rows, "inputTokens");
      const inputChange = before.length ? `${input >= mean(before, "inputTokens") ? "+" : ""}${number(input - mean(before, "inputTokens"))}` : "n/a";
      say(`${role}: runs ${rows.length} (Δ ${delta(rows.length, before.length, 0)}), exit 0 ${success.toFixed(1)}% (Δ ${delta(success, rate(before, exited(0)), 1, "pp")}), exit 4 ${refusal.toFixed(1)}% (Δ ${delta(refusal, rate(before, exited(4)), 1, "pp")}), mean input tokens ${number(input)} (Δ ${inputChange})`);
    }
    const codex = current.filter((row) => row.kind === "codex");
    for (const [rule, count] of top(codex, (row) => typeof row.refusal === "string" ? row.refusal.replace(/\s+/g, " ").trim().slice(0, 120) : null)) say(`refusal: ${rule} — ${count}`);
    for (const [issue, count] of top(codex.filter((row) => row.role === "fix"), (row) => Number.isSafeInteger(row.issue) && row.issue > 0 ? row.issue : null)) say(`fix issue: #${issue} — ${count}`);
    const ci = current.filter((row) => row.kind === "ci");
    if (ci.length) say(`CI: pass ${rate(ci, (row) => row.result === "pass").toFixed(1)}%, mean minutes ${mean(ci, "minutes").toFixed(1)}`);
    if (skipped) say(`skipped ${skipped} bad lines`);
    return 0;
  } catch (error) {
    warn(`qc metrics: ${error.message}`);
    return 1;
  }
}
