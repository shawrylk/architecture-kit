// The branch that checks a superpowers plan before anyone runs it. Each `### Task N:` names its files, has a
// test step and a commit step, and keeps any estimate within one implementer's tool-call budget.

import { readFileSync } from "node:fs";
import path from "node:path";
import { reviewDefaults } from "../config.mjs";
import { reviewSettings } from "./workflow-settings.mjs";

const TASK_HEADING = /^###[ \t]+Task[ \t]+(\d+)[ \t]*:[ \t]*(.*)$/;
const SECTION_END = /^#{1,3}[ \t]/;
const FILE_LINE = /^[ \t]*[-*][ \t]+(?:Create|Modify|Test|Delete|Rename):[ \t]*\S/i;
const STEP_LINE = /^[ \t]*[-*][ \t]+\[[ xX]\][ \t]+\*\*(.+?)\*\*/;
const ESTIMATE_LINE = /^[ \t]*\*\*Estimate:\*\*[ \t]*(\d+)(?:[ \t]*(?:-|to)[ \t]*(\d+))?/i;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const GIT_COMMIT = /\bgit[ \t]+commit\b/;
const TEST_WORD = /\btests?\b/i;
const COMMIT_WORD = /\bcommit\b/i;

/** The tasks of a plan, with their file lines, step titles, commit evidence, and estimate. Fenced code is not structure. */
export function parsePlan(markdown) {
  const tasks = [];
  let task = null;
  let fence = null;
  markdown.split(/\r?\n/).forEach((line, index) => {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
      else if (task && GIT_COMMIT.test(line)) task.commitCommand = true;
      return;
    }
    if (marker) {
      fence = marker;
      return;
    }
    const heading = TASK_HEADING.exec(line);
    if (heading) {
      task = { number: Number(heading[1]), title: heading[2].trim(), line: index + 1, files: 0, steps: [], commitCommand: false, estimate: null };
      tasks.push(task);
      return;
    }
    if (SECTION_END.test(line)) {
      task = null;
      return;
    }
    if (!task) return;
    if (FILE_LINE.test(line)) task.files += 1;
    const step = STEP_LINE.exec(line)?.[1];
    if (step) task.steps.push(step);
    const estimate = ESTIMATE_LINE.exec(line);
    if (estimate) task.estimate = Number(estimate[2] ?? estimate[1]);
  });
  return tasks;
}

/** @returns each way the plan breaks the format, one entry per task and problem. */
export function checkPlan(markdown, { maxTaskCalls = reviewDefaults.maxTaskCalls } = {}) {
  const tasks = parsePlan(markdown);
  if (tasks.length === 0) return [{ task: null, detail: "the plan has no `### Task N:` heading" }];
  const problems = [];
  for (const task of tasks) {
    const add = (detail) => problems.push({ task: task.number, detail });
    if (task.files === 0) add("names no file: list each as `- Create:`, `- Modify:` or `- Test:` with its path");
    if (!task.steps.some((step) => TEST_WORD.test(step))) add("has no test step: a step whose title names the test it writes or runs");
    if (!task.commitCommand && !task.steps.some((step) => COMMIT_WORD.test(step))) {
      add("has no commit step: a step titled Commit, or a `git commit` in a step's code");
    }
    if (task.estimate !== null && task.estimate > maxTaskCalls) {
      add(`estimates ${task.estimate} tool calls, over swarm.review.maxTaskCalls (${maxTaskCalls}); split it`);
    }
  }
  return problems;
}

/** `qc plan-check <plan.md>`. @returns the exit code */
export function runPlanCheck(config, [file] = []) {
  if (!file) {
    console.error("usage: qc plan-check <plan.md>");
    return 2;
  }
  let markdown;
  try {
    markdown = readFileSync(path.resolve(config.root ?? process.cwd(), file), "utf8");
  } catch (error) {
    console.error(`FAIL  plan-check  ${file}: cannot read it (${error.message})`);
    return 1;
  }
  let maxTaskCalls;
  try {
    maxTaskCalls = reviewSettings(config.swarm)?.maxTaskCalls ?? config.swarm?.review?.maxTaskCalls ?? reviewDefaults.maxTaskCalls;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  const problems = checkPlan(markdown, { maxTaskCalls });
  for (const problem of problems) {
    console.error(`FAIL  plan-check  ${problem.task === null ? file : `Task ${problem.task}`}: ${problem.detail}`);
  }
  if (problems.length > 0) return 1;
  const count = parsePlan(markdown).length;
  console.log(`OK  plan-check  ${file}: ${count} task${count === 1 ? "" : "s"}`);
  return 0;
}
