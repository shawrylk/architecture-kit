import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkPlan, parsePlan } from "./plan-check.mjs";

const QC = fileURLToPath(new URL("./qc.mjs", import.meta.url));
const FENCE = "`".repeat(3);

const task = (n, { files = true, fileLines = null, exempt = null, testStep = true, commit = true, estimate = null, extra = [] } = {}) =>
  [
    `### Task ${n}: Part ${n}`,
    "",
    "**Files:**",
    ...(fileLines ?? (files ? [`- Create: \`src/part-${n}.mjs\``, `- Test: \`src/part-${n}.test.mjs\``] : [])),
    ...(exempt === null ? [] : [exempt]),
    ...(estimate === null ? [] : [`**Estimate:** ${estimate} tool calls`]),
    "",
    ...(testStep ? ["- [ ] **Step 1: Write the failing test**"] : ["- [ ] **Step 1: Write the code**"]),
    ...extra,
    ...(commit ? ["- [ ] **Step 2: Commit**"] : []),
    "",
  ].join("\n");
const plan = (...tasks) => ["# Plan", "", "## Global Constraints", "", ...tasks, "## Notes", ""].join("\n");

test("a well-formed plan has no problem", () => {
  assert.deepEqual(checkPlan(plan(task(1, { estimate: 30 }), task(2))), []);
  assert.equal(parsePlan(plan(task(1), task(2))).length, 2);
});

test("a plan with no task heading is refused", () => {
  assert.deepEqual(checkPlan("# Plan\n\nJust prose.\n"), [{ task: null, detail: "the plan has no `### Task N:` heading" }]);
});

test("each missing part is named with its task", () => {
  const problems = checkPlan(plan(task(1, { files: false }), task(2, { testStep: false }), task(3, { commit: false })));
  assert.deepEqual(problems.map((problem) => problem.task), [1, 2, 3]);
  assert.match(problems[0].detail, /names no file/);
  assert.match(problems[1].detail, /no test step/);
  assert.match(problems[2].detail, /no commit step/);
});

test("an estimate over the budget is refused, and a range counts its upper end", () => {
  assert.match(checkPlan(plan(task(1, { estimate: 36 })))[0].detail, /estimates 36 tool calls, over swarm\.review\.maxTaskCalls \(35\)/);
  assert.match(checkPlan(plan(task(1, { estimate: "20-40" })))[0].detail, /estimates 40/);
  assert.deepEqual(checkPlan(plan(task(1, { estimate: 20 })), { maxTaskCalls: 20 }), []);
  assert.equal(checkPlan(plan(task(1, { estimate: 21 })), { maxTaskCalls: 20 }).length, 1);
});

test("fenced code is not structure, but a git commit in it is a commit step", () => {
  const fenced = [FENCE + "markdown", "### Task 9: Not a task", FENCE, FENCE + "bash", "git commit -m x", FENCE];
  const tasks = parsePlan(plan(task(1, { commit: false, extra: fenced })));
  assert.deepEqual(tasks.map((found) => found.number), [1]);
  assert.equal(tasks[0].commitCommand, true);
  assert.deepEqual(checkPlan(plan(task(1, { commit: false, extra: fenced }))), []);
});

test("qc plan-check exits 0 on a good plan and 1 on a bad one, reading the budget from the config", (t) => {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-plan-check-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {}, review: { maxTaskCalls: 10 } } }));
  writeFileSync(path.join(dir, "good.md"), plan(task(1, { estimate: 10 })));
  writeFileSync(path.join(dir, "bad.md"), plan(task(1, { estimate: 20 })));
  const good = spawnSync(process.execPath, [QC, "plan-check", "good.md"], { cwd: dir, encoding: "utf8" });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /OK {2}plan-check {2}good\.md: 1 task/);
  const bad = spawnSync(process.execPath, [QC, "plan-check", "bad.md"], { cwd: dir, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /FAIL {2}plan-check {2}Task 1: estimates 20 tool calls, over swarm\.review\.maxTaskCalls \(10\)/);
  const missing = spawnSync(process.execPath, [QC, "plan-check", "none.md"], { cwd: dir, encoding: "utf8" });
  assert.equal(missing.status, 1);
});

const DOC_FILES = ["- Modify: `README.md` (the table)", "- Modify: `packages/pkg/package.json` (`version` bump)", "- Modify: `CHANGELOG.md`"];

test("a task with no code may carry the Test: none line in place of a test step", () => {
  const exempt = "Test: none — a docs and version change with no code";
  const docs = task(1, { fileLines: DOC_FILES, exempt, testStep: false });
  assert.deepEqual(checkPlan(plan(docs)), []);
  assert.deepEqual(checkPlan(plan(task(1, { fileLines: DOC_FILES, exempt: "- " + exempt, testStep: false }))), []);
  assert.equal(parsePlan(plan(docs))[0].files, 3, "the exemption line is not a file");
});

test("the Test: none line needs a reason of a few words", () => {
  for (const exempt of ["Test: none", "Test: none — ", "Test: none — docs", "Test: none — docs only"]) {
    const problems = checkPlan(plan(task(1, { fileLines: DOC_FILES, exempt, testStep: false })));
    assert.equal(problems.length, 1, exempt);
    assert.match(problems[0].detail, /Test: none.*reason/, exempt);
  }
});

test("the Test: none line is refused for a task that names a source file", () => {
  const code = ["- Modify: `README.md`", "- Modify: `src/photos/create.ts` (drop the runner)"];
  const problems = checkPlan(plan(task(1, { fileLines: code, exempt: "Test: none — the gates cover this cleanup", testStep: false })));
  assert.equal(problems.length, 1);
  assert.match(problems[0].detail, /src\/photos\/create\.ts/);
  assert.match(problems[0].detail, /Test: none/);
  assert.equal(checkPlan(plan(task(1, { fileLines: code, exempt: "Test: none — the gates cover this cleanup" }))).length, 1, "a test step does not excuse it");
});

test("the missing-test-step message names the Test: none line as the way out", () => {
  const [problem] = checkPlan(plan(task(1, { testStep: false })));
  assert.match(problem.detail, /no test step/);
  assert.match(problem.detail, /Test: none — <reason>/);
});
