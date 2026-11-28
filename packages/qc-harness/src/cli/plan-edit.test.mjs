import test from "node:test";
import assert from "node:assert/strict";
import { parsePlanDoc, taskFiles } from "./plan-parse.mjs";
import { checkPlan } from "./plan-check.mjs";
import { PLAN_FIXTURE } from "./plan-fixture.mjs";
import { tickTask, setStatus, setApprovedBy, appendChangeLog, appendTaskStub } from "./plan-edit.mjs";
test("tickTask ticks every step of one task", () => {
  const doc = parsePlanDoc(tickTask(PLAN_FIXTURE, 2));
  assert.ok(doc.tasks[1].steps.every((step) => step.done));
});
test("tickTask keeps CRLF line endings", () => {
  const ticked = tickTask(PLAN_FIXTURE.replace(/\n/g, "\r\n"), 2);
  assert.ok(!/[^\r]\n/.test(ticked));
  assert.ok(parsePlanDoc(ticked).tasks[1].steps.every((step) => step.done));
});
test("tickTask leaves fenced steps alone", () => {
  const fenced = PLAN_FIXTURE + "\n```\n- [ ] **Step 9: test**\n```\n";
  assert.match(tickTask(fenced, 2), /```\n- \[ \] \*\*Step 9: test\*\*\n```/);
});
test("tickTask on a missing task throws", () => assert.throws(() => tickTask(PLAN_FIXTURE, 9), /no Task 9/));
test("tickTask on a done task returns the same text", () => assert.equal(tickTask(PLAN_FIXTURE, 1), PLAN_FIXTURE));
test("setStatus and setApprovedBy edit the header only", () => {
  const doc = parsePlanDoc(setApprovedBy(setStatus(PLAN_FIXTURE, "needs-approval"), "lead 2026-11-29"));
  assert.equal(doc.status, "needs-approval");
  assert.equal(doc.approvedBy, "lead 2026-11-29");
});
test("appendChangeLog adds the row at the end of the section", () => {
  const doc = parsePlanDoc(appendChangeLog(PLAN_FIXTURE, "2026-11-29 #13: fits Task 2"));
  assert.equal(doc.changeLog.at(-1).text, "2026-11-29 #13: fits Task 2");
  assert.deepEqual(doc.tasks.map((task) => task.number), [1, 2]);
});
test("appendChangeLog without the section throws", () => assert.throws(() => appendChangeLog("# x\n", "row"), /## Change log/));
test("appendTaskStub adds a task that passes checkPlan", () => {
  const text = appendTaskStub(PLAN_FIXTURE, { number: 3, title: "Cache", files: ["src/cache.mjs"], note: "Added by `qc plan revalidate` for #13." });
  assert.deepEqual(checkPlan(text), []);
  assert.deepEqual(taskFiles(parsePlanDoc(text).tasks[2]), ["src/cache.mjs"]);
});
test("header edits skip fenced headers and refuse missing headers", () => {
  const prefix = '```\nStatus: draft\nApproved-by: fake\n```\n';
  assert.ok(setStatus(prefix + PLAN_FIXTURE, "draft").startsWith(prefix));
  assert.ok(setApprovedBy(prefix + PLAN_FIXTURE, "lead").startsWith(prefix));
  assert.throws(() => setStatus(prefix, "draft"), /no Status:/);
  assert.throws(() => setApprovedBy(prefix, "lead"), /no Approved-by:/);
});
test("all text edits keep CRLF", () => {
  const text = PLAN_FIXTURE.replace(/\n/g, "\r\n");
  for (const result of [setStatus(text, "draft"), setApprovedBy(text, "lead"), appendChangeLog(text, "row"), appendTaskStub(text, {number:3,title:"Fix",files:["src/fix.mjs"],note:"Fix the file."})]) assert.ok(!/[^\r]\n/.test(result));
});
