#!/usr/bin/env node
// Print one markdown table per results file: each arm and task, then each arm over every task.
// Usage: node evals/agents/report.mjs <results.jsonl> [more.jsonl ...]

import { readFileSync } from "node:fs";

const records = process.argv.slice(2).flatMap((file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line)),
);
if (records.length === 0) throw new Error("usage: report.mjs <results.jsonl> [more.jsonl ...]");

const mean = (values) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const rate = (runs, test) => `${runs.filter(test).length}/${runs.length}`;
const fixed = (value, digits = 1) => value.toFixed(digits);

const columns = [
  ["solved", (runs) => rate(runs, (r) => r.solved)],
  ["tsc", (runs) => rate(runs, (r) => r.typecheck)],
  ["lint", (runs) => rate(runs, (r) => r.lint)],
  ["committed", (runs) => rate(runs, (r) => r.commits > 0)],
  ["clean tree", (runs) => rate(runs, (r) => r.dirty === 0)],
  ["in scope", (runs) => rate(runs, (r) => (r.outOfScope ?? []).length === 0)],
  ["median s", (runs) => String(median(runs.map((r) => r.seconds)))],
  ["mean $", (runs) => (runs.some((r) => r.costUsd === null) ? "n/a" : fixed(mean(runs.map((r) => r.costUsd)), 2))],
  ["tool calls", (runs) => fixed(mean(runs.map((r) => r.toolCalls)))],
  ["hook blocks", (runs) => fixed(mean(runs.map((r) => r.hookBlocks ?? 0)))],
  ["git fails", (runs) => fixed(mean(runs.map((r) => r.gitFails ?? 0)))],
];

function table(title, groups) {
  console.log(`\n### ${title}\n`);
  console.log(`| label | task | runs | ${columns.map(([name]) => name).join(" | ")} |`);
  console.log(`|${"---|".repeat(columns.length + 3)}`);
  for (const [key, runs] of groups) {
    console.log(`| ${key.join(" | ")} | ${runs.length} | ${columns.map(([, cell]) => cell(runs)).join(" | ")} |`);
  }
}

function groupBy(list, keyOf) {
  const groups = new Map();
  for (const record of list) {
    const key = keyOf(record);
    const id = key.join("\u0000");
    if (!groups.has(id)) groups.set(id, [key, []]);
    groups.get(id)[1].push(record);
  }
  return [...groups.values()].sort(([a], [b]) => a.join().localeCompare(b.join()));
}

for (const agent of [...new Set(records.map((r) => r.agent))]) {
  const mine = records.filter((r) => r.agent === agent);
  table(`${agent}: each task`, groupBy(mine, (r) => [r.label, r.task]));
  table(`${agent}: every task`, groupBy(mine, (r) => [r.label, "all"]));
}
