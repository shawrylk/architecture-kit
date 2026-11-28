import test from "node:test";
import assert from "node:assert/strict";
import { PLAN_FIXTURE, planWith } from "./plan-fixture.mjs";
import { parsePlanDoc, taskDone, nextTask, taskFiles } from "./plan-parse.mjs";

test("the fixture parses into header, services, change log and tasks", () => {
  const doc = parsePlanDoc(PLAN_FIXTURE);
  assert.equal(doc.issue, 12);
  assert.equal(doc.status, "approved");
  assert.equal(doc.approvedBy, "owner 2026-11-28");
  assert.deepEqual(Object.keys(doc.sections).sort(), ["Catalog", "Change log", "Goal", "Non-goals", "Services"]);
  assert.equal(doc.services[0].interfaceFile, "src/store/port.mjs");
  assert.ok(doc.serviceFiles.includes("src/store/port.mjs"));
  assert.equal(doc.changeLog.at(-1).text, "2026-11-28 approval: approved by owner; services 1");
  assert.deepEqual(doc.tasks.map((task) => task.number), [1, 2]);
  assert.deepEqual(doc.tasks[1].files[0], { kind: "Modify", paths: ["src/features/demo/trigger.mjs"], block: "trigger", lines: 120, line: doc.tasks[1].files[0].line });
});

test("taskDone and nextTask follow the checkboxes", () => {
  const doc = parsePlanDoc(PLAN_FIXTURE);
  assert.equal(taskDone(doc.tasks[0]), true);
  assert.equal(taskDone(doc.tasks[1]), false);
  assert.equal(nextTask(doc).number, 2);
});

test("a CRLF plan parses the same as an LF plan", () => {
  assert.deepEqual(parsePlanDoc(PLAN_FIXTURE.replace(/\n/g, "\r\n")), parsePlanDoc(PLAN_FIXTURE));
});

test("fenced lines are not structure", () => {
  const fenced = PLAN_FIXTURE + "\n```\n### Task 9: Fake\n- [ ] **Step 1: test**\nStatus: draft\n```\n";
  const doc = parsePlanDoc(fenced);
  assert.deepEqual(doc.tasks.map((task) => task.number), [1, 2]);
  assert.equal(doc.tasks[1].steps.length, 3);
});

test("None: services and Approved-by: none parse", () => {
  const doc = parsePlanDoc(planWith([[/### PlanStore[\s\S]*?(?=\n## Catalog)/, "None: a bug fix in existing code.\n"], ["Approved-by: owner 2026-11-28", "Approved-by: none"]]));
  assert.equal(doc.servicesNone, "a bug fix in existing code.");
  assert.deepEqual(doc.services, []);
  assert.equal(doc.approvedBy, null);
});

test("Split: and an HTML comment in a section parse", () => {
  const doc = parsePlanDoc(planWith([["(~120 lines)", "(~620 lines)\nSplit: the router stays whole"], ["Ship the demo.", "<!-- guide -->"]]));
  assert.equal(doc.tasks[1].split, "the router stays whole");
  assert.deepEqual(doc.sections.Goal.body.filter((line) => line.trim()), []);
});
