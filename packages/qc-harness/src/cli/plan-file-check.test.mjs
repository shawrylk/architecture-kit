import test from "node:test";
import assert from "node:assert/strict";
import { defaults } from "../config.mjs";
import { PLAN_FIXTURE, planWith } from "./plan-fixture.mjs";
import { parsePlanDoc } from "./plan-parse.mjs";
import { checkPlanFile, planSettings } from "./plan-file-check.mjs";
const rules = (markdown, options) => checkPlanFile(markdown, options).map((problem) => problem.detail).join("\n");

test("the fixture passes", () => assert.deepEqual(checkPlanFile(PLAN_FIXTURE), []));
test("a missing Status: fails", () => assert.match(rules(planWith([["Status: approved\n", ""]])), /Status:/));
test("an unknown status fails", () => assert.match(rules(planWith([["Status: approved", "Status: done"]])), /draft, approved or needs-approval/));
for (const section of ["Goal", "Non-goals", "Services", "Catalog", "Change log"]) {
  test(`a missing ## ${section} fails`, () => assert.match(rules(planWith([[`## ${section}\n`, "## Other\n"]])), new RegExp(`## ${section}`)));
}
test("a service without Scale: fails on its line", () => {
  const [problem] = checkPlanFile(planWith([[/- Scale:.*\n/, ""]]));
  assert.match(problem.detail, /Scale:/);
  assert.equal(problem.line, parsePlanDoc(PLAN_FIXTURE).services[0].line);
});
test("an Interface: without a file fails", () => assert.match(rules(planWith([["in `src/store/port.mjs`", "in the store"]])), /Interface:/));
test("Services with both None: and a block fails", () => assert.match(rules(planWith([["## Catalog", "None: no service.\n\n## Catalog"]])), /None:/));
test("an empty catalog fails", () => assert.match(rules(planWith([[/- Searched.*\n/, "<!-- fill -->\n"]])), /## Catalog/));
test("an estimate over plan.fileLines fails without Split:", () => {
  assert.match(rules(planWith([["(~120 lines)", "(~620 lines)"]])), /620.*500/);
  assert.deepEqual(checkPlanFile(planWith([["(~120 lines)", "(~620 lines)\nSplit: the router stays whole"]])), []);
  assert.deepEqual(checkPlanFile(planWith([["(~120 lines)", "(~620 lines)"]]), { fileLines: 700 }), []);
});
test("an unknown block name fails", () => assert.match(rules(planWith([["(block: trigger)", "(block: service)"]])), /service.*index, trigger/));
test("approved without Approved-by fails", () => assert.match(rules(planWith([["Approved-by: owner 2026-11-28", "Approved-by: none"]])), /Approved-by/));
test("Approved-by: lead with services fails", () => assert.match(rules(planWith([["Approved-by: owner", "Approved-by: lead"]])), /lead.*None:/));
test("Approved-by: lead with None: services passes", () => {
  const none = planWith([[/### PlanStore[\s\S]*?(?=\n## Catalog)/, "None: a bug fix in existing code.\n"], ["Approved-by: owner", "Approved-by: lead"], ["services 1", "services 0"]]);
  assert.deepEqual(checkPlanFile(none), []);
});
test("a service added after approval needs approval", () => {
  const added = planWith([["## Catalog", "### Cache\n- Interface: `Cache` in `src/cache/port.mjs`: get(key)\n- Now: a map.\n- Scale: Redis, past 10 PCs.\n\n## Catalog"]]);
  assert.match(rules(added), /needs-approval/);
});
test("an added task that touches an interface file after approval needs approval", () => {
  const added = planWith([["- 2026-11-28 approval: approved by owner; services 1", "- 2026-11-28 approval: approved by owner; services 1\n- 2026-11-29 #13: adds Task 3 \"Port fix\"; files src/store/port.mjs"]])
    + "\n### Task 3: Port fix\n\n**Files:**\n- Modify: `src/store/port.mjs`\n\n- [ ] **Step 1: Write the failing test**\n- [ ] **Step 2: Commit**\n";
  assert.match(rules(added), /Task 3.*src\/store\/port\.mjs.*needs-approval/);
});
test("checkPlan problems pass through with the task line", () => {
  const [problem] = checkPlanFile(planWith([["- [ ] **Step 3: Commit**", ""]]));
  assert.equal(problem.task, 2);
  assert.match(problem.detail, /commit step/);
});
test("planSettings refuses a bad plan.fileLines", () => {
  assert.throws(() => planSettings({ plan: { dir: "docs/plans", fileLines: 0 } }), /plan.fileLines must be a positive whole number/);
  assert.deepEqual(planSettings(defaults), { dir: "docs/plans", fileLines: 500 });
});
