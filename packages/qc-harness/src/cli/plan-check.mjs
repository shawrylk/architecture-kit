// The branch that checks a superpowers plan before anyone runs it. Each `### Task N:` names its files, has a
// test step and a commit step, and keeps any estimate within one implementer's tool-call budget.

import { readFileSync } from "node:fs";
import path from "node:path";
import { reviewDefaults } from "../config.mjs";
import { pathMatcher } from "../glob.mjs";
import { reviewSettings } from "./workflow-settings.mjs";

const TASK_HEADING = /^###[ \t]+Task[ \t]+(\d+)[ \t]*:[ \t]*(.*)$/;
const SECTION_END = /^#{1,3}[ \t]/;
const FILE_LINE = /^[ \t]*[-*][ \t]+(?:Create|Modify|Test|Delete|Rename):[ \t]*\S/i;
const STEP_LINE = /^[ \t]*[-*][ \t]+\[[ xX]\][ \t]+\*\*(.+?)\*\*/;
const ESTIMATE_LINE = /^[ \t]*\*\*Estimate:\*\*[ \t]*(\d+)(?:[ \t]*(?:-|–|—|to)[ \t]*(\d+))?/i;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const RISK_LINE = /^[ \t]*\*\*Risk:\*\*[ \t]*\S/i;
const GIT_COMMIT = /\bgit[ \t]+commit\b/;
const TEST_WORD = /\btests?\b/i;
const COMMIT_WORD = /\bcommit\b/i;
const NO_TEST_LINE = /^[ \t]*(?:[-*][ \t]+)?Test:[ \t]*none(?![\w.])(.*)$/i;
const NO_TEST_DASH = /^[ \t]*(?:—|–|--?)[ \t]*/;
const NO_TEST_WORDS = 3;
const PATH_LINE = /^[ \t]*[-*][ \t]+(?:Create|Modify|Test|Delete|Rename)\b/i;
const DOC_FILE = /\.(?:md|mdx|txt|json|ya?ml)$|^(?:CHANGELOG|LICENSE)|^VERSION$/i;
const BARE_NAME = /^(?:Dockerfile|Makefile|Jenkinsfile|Procfile|Gemfile|Rakefile|Vagrantfile|Brewfile)$/i;
const NOT_A_PATH = /^(?:v?\d+(?:\.\d+)+|\d+(?:-\d+)?|e\.g|i\.e|etc|vs)$/i;
const NO_TEST_SPELLING = "`Test: none — <reason>`";

const tidy = (word) => word.replace(/^[(["']+/, "").replace(/[)\]"',;.]+$/, "").replace(/:\d+(?:-\d+)?$/, "");

/** The fragment that reads every path a Create, Modify, Test, Delete, or Rename line names. */
function filesOf(line) {
  const rest = line.replace(/^[^:]*:/, "");
  const found = [/^\s*`([^`\s]+)`/.exec(rest)?.[1]];
  for (const [, span] of rest.matchAll(/`([^`\s]+)`/g)) found.push(span);
  for (const token of rest.replace(/`/g, " ").split(/\s+/)) found.push(token);
  const named = (word) => /[/.]/.test(word) || BARE_NAME.test(word);
  const paths = found.filter((word) => word).map(tidy).filter((word) => word !== "" && !NOT_A_PATH.test(word));
  const first = found[0] ? tidy(found[0]) : null;
  const isPath = (word) => word === first || named(word);
  return [...new Set(paths.filter(isPath).map((word) => word.replace(/\\/g, "/")))];
}

/** The tasks of a plan, with their file lines, step titles, commit evidence, and estimate. Fenced code is not structure. */
export function parsePlan(markdown) {
  const tasks = [];
  let task = null;
  let fence = null;
  let testStep = null;
  markdown.split(/\r?\n/).forEach((line, index) => {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (task && testStep && !marker) testStep.push(line);
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
      testStep = null;
      task = {
        number: Number(heading[1]),
        title: heading[2].trim(),
        line: index + 1,
        files: 0,
        steps: [],
        testSteps: [],
        commitCommand: false,
        estimate: null,
        sourceFiles: [],
        filePaths: [],
        risk: false,
        noTest: null,
      };
      tasks.push(task);
      return;
    }
    if (SECTION_END.test(line)) {
      task = null;
      testStep = null;
      return;
    }
    if (!task) return;
    const noTest = NO_TEST_LINE.exec(line);
    if (noTest) {
      const reason = noTest[1].replace(NO_TEST_DASH, "").trim();
      task.noTest = { reason, words: reason === "" ? 0 : reason.split(/\s+/).length };
      return;
    }
    if (PATH_LINE.test(line)) {
      const files = filesOf(line);
      task.filePaths.push(...files);
      task.sourceFiles.push(...files.filter((file) => !DOC_FILE.test(file.split("/").pop())));
    }
    if (RISK_LINE.test(line)) task.risk = true;
    if (FILE_LINE.test(line)) task.files += 1;
    const step = STEP_LINE.exec(line)?.[1];
    if (step) {
      task.steps.push(step);
      testStep = TEST_WORD.test(step) ? [line] : null;
      if (testStep) task.testSteps.push(testStep);
    } else if (testStep && !RISK_LINE.test(line)) testStep.push(line);
    const estimate = ESTIMATE_LINE.exec(line);
    if (estimate) task.estimate = Number(estimate[2] ?? estimate[1]);
  });
  return tasks;
}

/** @returns each way the plan breaks the format, one entry per task and problem. */
export function checkPlan(markdown, { maxTaskCalls = reviewDefaults.maxTaskCalls, riskPaths = reviewDefaults.riskPaths, cases = reviewDefaults.cases } = {}) {
  const tasks = parsePlan(markdown);
  if (tasks.length === 0) return [{ task: null, detail: "the plan has no `### Task N:` heading" }];
  const problems = [];
  const risky = pathMatcher(riskPaths);
  const caseRules = Object.entries(cases).map(([glob, words]) => ({
    matches: pathMatcher([glob]),
    words: words.map((word) => ({ word, pattern: new RegExp(`(?<!\\w)${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\w)`, "i") })),
  }));
  for (const task of tasks) {
    const add = (detail) => problems.push({ task: task.number, detail });
    if (task.filePaths.some(risky) && !task.risk) add("missing **Risk:** line: name the failure condition, how it shows, and how to reverse it");
    const missing = new Set();
    for (const rule of caseRules) {
      if (!task.filePaths.some(rule.matches)) continue;
      for (const { word, pattern } of rule.words) {
        if (!task.testSteps.some((step) => pattern.test(step.join("\n")))) missing.add(word);
      }
    }
    if (missing.size) add(`missing cases in the test step: ${[...missing].join(", ")}`);
    if (task.files === 0) add("names no file: list each as `- Create:`, `- Modify:` or `- Test:` with its path");
    if (task.noTest) {
      if (task.noTest.words < NO_TEST_WORDS) {
        add(`carries \`Test: none\` without a reason of at least ${NO_TEST_WORDS} words: write ${NO_TEST_SPELLING}`);
      }
      else if (task.sourceFiles.length > 0) {
        add(`carries \`Test: none\` but names source code (${task.sourceFiles.join(", ")}); ${NO_TEST_SPELLING} is only for a task with no code`);
      }
    } else if (!task.steps.some((step) => TEST_WORD.test(step))) {
      add(`has no test step: a step whose title names the test it writes or runs, or for a task with no code the line ${NO_TEST_SPELLING}`);
    }
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
  let settings;
  try {
    settings = reviewSettings(config.swarm) ?? config.swarm?.review ?? {};
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  const problems = checkPlan(markdown, settings);
  for (const problem of problems.slice(0, 3)) {
    console.error(`FAIL  plan-check  ${problem.task === null ? file : `Task ${problem.task}`}: ${problem.detail}`);
  }
  if (problems.length > 0) return 1;
  return 0;
}
