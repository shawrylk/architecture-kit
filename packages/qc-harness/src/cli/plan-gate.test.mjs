import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { load } from "../config.mjs";
import { planCheckOptions } from "./plan-file-check.mjs";
import { PLAN_FIXTURE, planWith } from "./plan-fixture.mjs";
import { filePlanStore } from "./plan-store.mjs";
import { planStartRefusal, pathInTask } from "./plan-gate.mjs";
function fx(t, text = PLAN_FIXTURE) {
  const root = mkdtempSync(path.join(tmpdir(), "qc-plan-gate-"));
  t.after(() => rmSync(root, {recursive:true,force:true,maxRetries:5,retryDelay:100}));
  mkdirSync(path.join(root,"docs/plans"), {recursive:true});
  writeFileSync(path.join(root,"docs/plans/12-demo.md"),text);
  return {root,options:planCheckOptions(load(root))};
}
const diffPaths = (brief) => [...(/^Paths:.*$/m.exec(brief)?.[0] ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1]);
const BRIEF = "Plan: `docs/plans/12-demo.md`\nTask: `2`\nPaths: `src/features/demo/trigger.mjs`, `src/features/demo/trigger.test.mjs`\n";
const refusal = (f, brief, paths = diffPaths(brief)) => planStartRefusal({ brief, paths, store: filePlanStore(f.root), options: f.options });

test("an approved plan and an open task start", (t) => assert.equal(refusal(fx(t), BRIEF), null));
test("a folder that holds a task file passes", (t) => assert.equal(refusal(fx(t), BRIEF, ["src/features/demo/"]), null));
test("a backslash path passes", (t) => assert.equal(refusal(fx(t), BRIEF, ["src\\features\\demo\\trigger.mjs"]), null));
test("a fix round skips the gate", (t) => assert.equal(refusal(fx(t), "Proof: `r.md`\nPaths: `src/other.mjs`\n", ["src/other.mjs"]), null));
test("no Plan: refuses", (t) => assert.match(refusal(fx(t), "Paths: `a.mjs`\n", ["a.mjs"]), /Plan: is required.*qc plan new/));
test("no Task: refuses", (t) => assert.match(refusal(fx(t), "Plan: `docs/plans/12-demo.md`\n", []), /Task: <N> is required/));
test("a missing plan refuses", (t) => assert.match(refusal(fx(t), BRIEF.replace("12-demo", "13-x")), /cannot be read/));
test("a plan outside the worktree refuses", (t) => assert.match(refusal(fx(t), BRIEF.replace("docs/plans/12-demo.md", "../other/plan.md")), /cannot be read: .*outside/));
test("a failing plan check refuses with the line", (t) => {
  const f = fx(t, planWith([[/- Scale:.*\n/, ""]]));
  assert.match(refusal(f, BRIEF), /docs\/plans\/12-demo\.md:\d+: .*Scale:.*qc plan check/);
});
test("a draft plan refuses", (t) => assert.match(refusal(fx(t, planWith([["Status: approved", "Status: draft"]])), BRIEF), /:4: Status is draft.*qc plan approve/));
test("a needs-approval plan refuses", (t) => assert.match(refusal(fx(t, planWith([["Status: approved", "Status: needs-approval"]])), BRIEF), /Status is needs-approval/));
test("a missing task refuses", (t) => assert.match(refusal(fx(t), BRIEF.replace("Task: `2`", "Task: `9`")), /has no Task 9/));
test("a done task refuses", (t) => assert.match(refusal(fx(t), BRIEF.replace("Task: `2`", "Task: `1`"), ["src/store/port.mjs"]), /Task 1 is done.*qc plan status/));
test("a Paths: entry outside the task refuses and offers revalidate", (t) => {
  assert.match(refusal(fx(t), BRIEF, ["src/other.mjs"]), /Paths: `src\/other\.mjs` is not a file of Task 2.*qc plan revalidate/);
});
test("the gate reads one local plan", (t) => {
  const f=fx(t), store=filePlanStore(f.root);
  let reads=0;
  assert.equal(planStartRefusal({brief:BRIEF,paths:diffPaths(BRIEF),options:f.options,store:{read:(ref)=>{reads++;return store.read(ref);}}}),null);
  assert.equal(reads,1);
});
test("pathInTask handles roots and respects folder boundaries", () => {
  for (const entry of [".","./","./src/", "src\\features\\demo\\"]) assert.equal(pathInTask(entry,["src/features/demo/trigger.mjs"]),true);
  for (const entry of ["src/feature", "src/other.mjs"]) assert.equal(pathInTask(entry,["src/features/demo/trigger.mjs"]),false);
});
