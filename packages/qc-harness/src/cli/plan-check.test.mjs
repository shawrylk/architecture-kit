import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkPlan, parsePlan } from "./plan-check.mjs";
import { reviewDefaults } from "../config.mjs";
import { reviewSettings } from "./workflow-settings.mjs";

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
  assert.equal(good.stdout, "");
  const bad = spawnSync(process.execPath, [QC, "plan-check", "bad.md"], { cwd: dir, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /FAIL {2}plan-check {2}Task 1: estimates 20 tool calls, over swarm\.review\.maxTaskCalls \(10\)/);
  const missing = spawnSync(process.execPath, [QC, "plan-check", "none.md"], { cwd: dir, encoding: "utf8" });
  assert.equal(missing.status, 1);
});

test("risky paths require a non-empty Risk line on their own task", () => {
  assert.deepEqual(reviewDefaults.riskPaths, ["**/migrations/**", "schemas/**"]);
  for (const file of ["migrations/001.sql", "db/migrations/001.sql", "schemas/api.yaml", "schemas\\api.json"]) {
    const risky = task(2, { fileLines: [`- Modify: \`${file}\``] });
    const problems = checkPlan(plan(task(1, { extra: ["**Risk:** A write fails; logs show it; revert the migration."] }), risky));
    assert.equal(problems.length, 1, file);
    assert.equal(problems[0].task, 2);
    assert.match(problems[0].detail, /missing.*\*\*Risk:\*\*/);
    assert.deepEqual(checkPlan(plan(risky), { riskPaths: [] }), []);
    assert.deepEqual(checkPlan(plan(risky.replace("**Files:**", "**Risk:** A write fails; logs show it; revert the migration.\n**Files:**"))), []);
    for (const extra of [["**Risk:**   "], [FENCE, "**Risk:** A write fails; logs show it; revert.", FENCE]]) {
      assert.equal(checkPlan(plan(task(1, { fileLines: [`- Modify: \`${file}\``], extra }))).length, 1);
    }
  }
  assert.deepEqual(checkPlan(plan(task(1))), []);
  assert.equal(checkPlan(plan(task(1)), { riskPaths: ["src/**"] }).length, 1);
});

test("review settings accept riskPaths and reject malformed glob lists", () => {
  assert.deepEqual(reviewSettings({ dispatch: {}, review: { riskPaths: [] } }).riskPaths, []);
  assert.deepEqual(reviewSettings({ dispatch: {} }).riskPaths, reviewDefaults.riskPaths);
  for (const riskPaths of [null, false, "schemas/**", [1], [""]]) {
    assert.throws(() => reviewSettings({ dispatch: {}, review: { riskPaths } }), /riskPaths/);
  }
});

test("configured acceptance cases match whole words anywhere in a task's test step", () => {
  assert.deepEqual(reviewDefaults.cases, {});
  const cases = { "src/**": ["loading", "error", "empty", "success"] };
  const complete = task(1, { extra: ["Verify LOADING, Error, empty, and success."] });
  assert.deepEqual(checkPlan(plan(complete), { cases }), []);
  assert.deepEqual(checkPlan(plan(task(1, { extra: [FENCE + "js", "test('loading, error, empty, success', run)", FENCE] })), { cases }), []);
  const missing = checkPlan(plan(task(2, { extra: ["Test unloading, errors, nonempty, and successful."] })), { cases });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].task, 2);
  assert.match(missing[0].detail, /missing.*test step.*loading, error, empty, success/);
  assert.deepEqual(checkPlan(plan(task(1))), []);
  assert.deepEqual(checkPlan(plan(task(1)), { cases: { "ui/**": ["loading"] } }), []);
  const outside = task(1).replace("**Files:**", "loading error empty success\n**Files:**") + "- [ ] **Commit: loading error empty success**\n";
  assert.equal(checkPlan(plan(outside), { cases }).length, 1);
  assert.equal(checkPlan(plan(complete, task(2)), { cases }).length, 1, "cases stay within their task");
  const overlap = { "src/**": ["loading"], "**/*.mjs": ["error"] };
  assert.match(checkPlan(plan(task(1, { extra: ["loading"] })), { cases: overlap })[0].detail, /error/);
  assert.deepEqual(checkPlan(plan(task(1, { extra: ["Test c++ and a.b"] })), { cases: { "src/**": ["c++", "a.b"] } }), []);
});

test("review settings accept case maps and reject malformed case lists", () => {
  const cases = { "ui/**": ["loading", "error", "empty", "success"] };
  assert.deepEqual(reviewSettings({ dispatch: {}, review: { cases } }).cases, cases);
  assert.deepEqual(reviewSettings({ dispatch: {} }).cases, {});
  for (const cases of [null, [], false, "ui/**", { "": ["error"] }, { "ui/**": "error" }, { "ui/**": [1] }, { "ui/**": [""] }]) {
    assert.throws(() => reviewSettings({ dispatch: {}, review: { cases } }), /cases/);
  }
});

test("the CLI reads risk and case configuration and bounds refusals", (t) => {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-plan-safety-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const review = { riskPaths: ["src/**"], cases: { "src/**": ["loading", "error"] } };
  writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {}, review } }));
  writeFileSync(path.join(dir, "plan.md"), plan(task(4)));
  const bad = spawnSync(process.execPath, [QC, "plan-check", "plan.md"], { cwd: dir, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /Task 4: missing \*\*Risk:\*\*/);
  assert.match(bad.stderr, /Task 4: missing.*test step.*loading, error/);
  assert.ok(bad.stderr.trim().split("\n").length <= 3);
  writeFileSync(path.join(dir, "plan.md"), plan(task(4, { extra: ["Check loading and error.", "**Risk:** Writes fail; errors appear; revert the change."] })));
  const good = spawnSync(process.execPath, [QC, "plan-check", "plan.md"], { cwd: dir, encoding: "utf8" });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.stdout + good.stderr, "");
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

const EXEMPT = "Test: none — the gates cover this cleanup";
const refusedFor = (fileLines) => checkPlan(plan(task(1, { fileLines, exempt: EXEMPT, testStep: false })));

test("a line range after the path does not hide a source file", () => {
  const problems = refusedFor(["- Modify: `src/a.ts:12-40`", "- Modify: `src/b.mjs:7`"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].detail, /src\/a\.ts/);
  assert.match(problems[0].detail, /src\/b\.mjs/);
  assert.deepEqual(refusedFor(["- Modify: `docs/guide.md:3-9`", "- Modify: `package.json:2`"]), []);
});

test("every path on a Files line is read, not only the first", () => {
  assert.equal(refusedFor(["- Modify: `README.md`, `src/b.ts`"]).length, 1);
  assert.equal(refusedFor(["- Modify: README.md and scripts/build.sh"]).length, 1);
  assert.equal(refusedFor(["- Modify: `README.md`; Test: `backend/tests/cli.test.ts`"]).length, 1);
});

test("a path that is not a document counts as source, so the exemption fails closed", () => {
  for (const name of ["Dockerfile", "Makefile", "bin/run", "src/a.mts", "src/a.cts", "api/photo.proto", "infra/main.tf"]) {
    const problems = refusedFor([`- Modify: \`README.md\`, \`${name}\``]);
    assert.equal(problems.length, 1, name);
    assert.match(problems[0].detail, new RegExp(name.replace(/[./]/g, "\\$&")), name);
  }
  assert.equal(refusedFor(["- Modify: `Dockerfile`"]).length, 1);
  const docs = ["- Modify: `CHANGELOG.md`", "- Modify: `LICENSE`", "- Modify: `a/b.yaml`, `c.yml`, `d.json`", "- Modify: `notes.txt`, `page.mdx`"];
  assert.deepEqual(refusedFor(docs), []);
});

test("an estimate range accepts a hyphen, an en dash, an em dash, and to", () => {
  for (const range of ["20-40", "20–40", "20—40", "20 to 40"]) {
    assert.match(checkPlan(plan(task(1, { estimate: range })))[0].detail, /estimates 40 tool calls, over/, range);
  }
  assert.deepEqual(checkPlan(plan(task(1, { estimate: "10–30" }))), []);
});
