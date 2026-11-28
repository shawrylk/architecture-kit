import test from "node:test";
import assert from "node:assert/strict";
import { parsePlanDoc } from "./plan-parse.mjs";
import { PLAN_FIXTURE, planWith } from "./plan-fixture.mjs";
import { lineCount, planReviewNotes, planReviewText } from "./plan-review.mjs";
const doc = parsePlanDoc(PLAN_FIXTURE);
const notes = (files, before = new Map(), after = new Map(), d = doc) => planReviewNotes({ ref: "docs/plans/12-demo.md", doc: d, task: 2, files, before, after, fileLines: 500 });

test("files outside the task are drift; the plan file and done-task files are not", () => {
  const lines = notes(["src/features/demo/trigger.mjs", "src/other.mjs", "docs/plans/12-demo.md", "src/store/port.mjs"]);
  assert.match(lines.join("\n"), /Plan drift: files outside Task 2 of `docs\/plans\/12-demo\.md`: `src\/other\.mjs`\. /);
  assert.doesNotMatch(lines.join("\n"), /port\.mjs|12-demo\.md`, /);
});
test("a file that grows past plan.fileLines gets a size note", () => {
  const file = "src/features/demo/trigger.mjs";
  assert.match(notes([file], new Map([[file, 480]]), new Map([[file, 530]])).join("\n"), /Plan size: `src\/features\/demo\/trigger\.mjs` grew past plan\.fileLines \(500\): 480 to 530 lines\./);
});
test("a file already over the limit gets no size note", () => {
  const file = "src/features/demo/trigger.mjs";
  assert.doesNotMatch(notes([file], new Map([[file, 700]]), new Map([[file, 720]])).join("\n"), /Plan size/);
});
test("a task with Split: gets no size note", () => {
  const file = "src/features/demo/trigger.mjs";
  const split = parsePlanDoc(planWith([["(~120 lines)", "(~620 lines)\nSplit: the router stays whole"]]));
  assert.doesNotMatch(notes([file], new Map([[file, 480]]), new Map([[file, 620]]), split).join("\n"), /Plan size/);
});
test("the reviewer line is always there", () => assert.match(notes([]).at(-1), /^Plan check: compare the diff with Task 2, ## Services and ## Catalog of `docs\/plans\/12-demo\.md`\./));
test("lineCount ignores a trailing newline", () => {
  assert.equal(lineCount(""), 0);
  assert.equal(lineCount("a\nb\n"), 2);
  assert.equal(lineCount("a\r\nb"), 2);
});
test("planReviewText skips a brief with no plan", async () => {
  assert.equal(await planReviewText({source:"Paths: `src/`",worktree:"missing"}), "");
});
test("planReviewText measures base and current files and handles additions and deletions", async (t) => {
  const {mkdtempSync,mkdirSync,writeFileSync,rmSync} = await import("node:fs");
  const {tmpdir} = await import("node:os");
  const path = await import("node:path");
  const root = mkdtempSync(path.join(tmpdir(),"qc-plan-review-"));
  t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  mkdirSync(path.join(root,"docs/plans"),{recursive:true});
  writeFileSync(path.join(root,"docs/plans/12-demo.md"),PLAN_FIXTURE);
  writeFileSync(path.join(root,"new.mjs"),"x\n".repeat(501));
  const calls=[];
  const text=await planReviewText({source:"Plan: `docs/plans/12-demo.md`\nTask: 2",worktree:root,base:"base",files:["new.mjs","deleted.mjs"],fileLines:500,git:async(_root,...args)=>{calls.push(args); if(args[1]==="base:new.mjs") throw new Error("new file"); return {stdout:"old\n"};}});
  assert.match(text,/`new.mjs` grew.*0 to 501 lines/);
  assert.doesNotMatch(text,/Plan size: `deleted.mjs`/);
  assert.deepEqual(calls,[["show","base:new.mjs"],["show","base:deleted.mjs"]]);
});
