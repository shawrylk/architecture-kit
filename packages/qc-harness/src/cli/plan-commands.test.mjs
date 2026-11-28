import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { load } from "../config.mjs";
import { PLAN_FIXTURE, planWith } from "./plan-fixture.mjs";
import { parsePlanDoc, taskDone } from "./plan-parse.mjs";
import { checkPlanFile } from "./plan-file-check.mjs";
import { runPlan } from "./plan-commands.mjs";
const QC = fileURLToPath(new URL("./qc.mjs", import.meta.url));
function fixture(t, config = {}, text) {
  const root = mkdtempSync(path.join(tmpdir(), "qc-plan-commands-"));
  t.after(() => rmSync(root, {recursive:true,force:true,maxRetries:5,retryDelay:100}));
  writeFileSync(path.join(root, "qc.config.json"), JSON.stringify(config));
  const ref = "docs/plans/12-demo.md";
  mkdirSync(path.join(root, "docs/plans"), {recursive:true});
  if (text !== undefined) writeFileSync(path.join(root, ref), text);
  const out = [], err = [];
  return {root,config:load(root),ref,out,err,text:()=>readFileSync(path.join(root,ref),"utf8"),deps:{now:()=>Date.UTC(2026,10,29),out:(line)=>out.push(line),err:(line)=>err.push(line)}};
}
test("plan new writes the template and refuses a second plan for the issue", (t) => {
  const f = fixture(t);
  assert.equal(runPlan(f.config, ["new", "12", "demo"], f.deps), 0);
  const text = readFileSync(path.join(f.root, "docs/plans/12-demo.md"), "utf8");
  assert.match(text, /^Issue: #12$/m);
  assert.match(text, /^Status: draft$/m);
  assert.match(text, /rg -n <name>/);
  assert.equal(runPlan(f.config, ["new", "12", "other"], f.deps), 1);
  assert.match(f.err.join("\n"), /docs\/plans\/12-demo\.md/);
});
test("plan new names the UI catalog when the gate is on", (t) => {
  const f = fixture(t, { gates: { "ui-catalog": true } });
  runPlan(f.config, ["new", "7", "ui"], f.deps);
  assert.match(readFileSync(path.join(f.root, "docs/plans/7-ui.md"), "utf8"), /qc ui find/);
});
test("plan new refuses a bad topic", (t) => {
  const f = fixture(t);
  assert.equal(runPlan(f.config, ["new", "12", "Bad Topic"], f.deps), 2);
});
test("a fresh template fails plan check on the empty catalog", (t) => {
  const f = fixture(t);
  runPlan(f.config, ["new", "12", "demo"], f.deps);
  assert.equal(runPlan(f.config, ["check", "docs/plans/12-demo.md"], f.deps), 1);
  assert.match(f.err.join("\n"), /^FAIL  plan  docs\/plans\/12-demo\.md:\d+: /m);
});
test("plan check passes the fixture silently", (t) => {
  const f = fixture(t, {}, PLAN_FIXTURE);
  assert.equal(runPlan(f.config, ["check", f.ref], f.deps), 0);
  assert.deepEqual([...f.out, ...f.err], []);
});
test("plan status prints the tasks, the next task and the last change", (t) => {
  const f = fixture(t, {}, PLAN_FIXTURE);
  assert.equal(runPlan(f.config, ["status", f.ref], f.deps), 0);
  assert.deepEqual(f.out, [
    `${f.ref}: status approved, next Task 2`,
    "Task 1 done  Port",
    "Task 2 next  Feature trigger",
    "Last change: 2026-11-28 approval: approved by owner; services 1",
  ]);
});
test("revalidate --fits writes one row and keeps the status", (t) => {
  const f = fixture(t, {}, PLAN_FIXTURE);
  assert.equal(runPlan(f.config, ["revalidate", f.ref, "#13", "--fits", "2"], f.deps), 0);
  const doc = parsePlanDoc(f.text());
  assert.equal(doc.changeLog.at(-1).text, "2026-11-29 #13: fits Task 2");
  assert.equal(doc.status, "approved");
});
test("revalidate --fits refuses a missing task", (t) => {
  const f = fixture(t, {}, PLAN_FIXTURE);
  assert.equal(runPlan(f.config, ["revalidate", f.ref, "#13", "--fits", "9"], f.deps), 1);
});
test("revalidate --adds a plain file appends a stub and keeps approved", (t) => {
  const f = fixture(t, {}, PLAN_FIXTURE);
  assert.equal(runPlan(f.config, ["revalidate", f.ref, "#13", "--adds", "Copy fix", "--files", "src/copy.mjs"], f.deps), 0);
  const doc = parsePlanDoc(f.text());
  assert.equal(doc.status, "approved");
  assert.equal(doc.tasks.at(-1).title, "Copy fix");
  assert.deepEqual(checkPlanFile(f.text()), []);
});
test("revalidate --adds an interface file sets needs-approval", (t) => {
  const f = fixture(t, {}, PLAN_FIXTURE);
  runPlan(f.config, ["revalidate", f.ref, "#13", "--adds", "Port fix", "--files", "src/store/port.mjs"], f.deps);
  const doc = parsePlanDoc(f.text());
  assert.equal(doc.status, "needs-approval");
  assert.match(doc.changeLog.at(-1).text, /adds Task 3 "Port fix"; files src\/store\/port\.mjs; needs approval/);
});
test("revalidate --new-plan and --out write their rows", (t) => {
  const f = fixture(t, {}, PLAN_FIXTURE);
  runPlan(f.config, ["revalidate", f.ref, "#14", "--new-plan"], f.deps);
  runPlan(f.config, ["revalidate", f.ref, "#15", "--out", "a docs typo"], f.deps);
  assert.deepEqual(parsePlanDoc(f.text()).changeLog.slice(-2).map((row) => row.text), ["2026-11-29 #14: needs a new plan", "2026-11-29 #15: out of scope: a docs typo"]);
});
test("revalidate refuses two modes", (t) => {
  const f = fixture(t, {}, PLAN_FIXTURE);
  assert.equal(runPlan(f.config, ["revalidate", f.ref, "#13", "--fits", "2", "--new-plan"], f.deps), 2);
});
test("approve --by owner records the approval row", (t) => {
  const f = fixture(t, {}, planWith([["Status: approved", "Status: needs-approval"]]));
  assert.equal(runPlan(f.config, ["approve", f.ref, "--by", "owner"], f.deps), 0);
  const doc = parsePlanDoc(f.text());
  assert.equal(doc.status, "approved");
  assert.equal(doc.approvedBy, "owner 2026-11-29");
  assert.equal(doc.changeLog.at(-1).text, "2026-11-29 approval: approved by owner; services 1");
});
test("approve --by lead refuses a plan with services and writes nothing", (t) => {
  const f = fixture(t, {}, PLAN_FIXTURE);
  assert.equal(runPlan(f.config, ["approve", f.ref, "--by", "lead"], f.deps), 1);
  assert.equal(f.text(), PLAN_FIXTURE);
});
test("done ticks the task and refuses a missing one", (t) => {
  const f = fixture(t, {}, PLAN_FIXTURE);
  assert.equal(runPlan(f.config, ["done", f.ref, "2"], f.deps), 0);
  assert.ok(taskDone(parsePlanDoc(f.text()).tasks[1]));
  assert.equal(runPlan(f.config, ["done", f.ref, "9"], f.deps), 1);
});
test("qc plan status runs through the CLI", (t) => {
  const f = fixture(t, {}, PLAN_FIXTURE);
  const result = spawnSync(process.execPath, [QC, "plan", "status", f.ref], { cwd: f.root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /next Task 2/);
});
test("bad usage refuses before a write", (t) => {
  const f = fixture(t, {}, PLAN_FIXTURE);
  for (const args of [[], ["unknown"], ["new", "bad", "demo"], ["check"], ["check", f.ref, "extra"], ["done", f.ref, "NaN"], ["approve", f.ref], ["approve", f.ref, "--by"], ["revalidate", f.ref, "#13"], ["revalidate", f.ref, "#13", "--adds", "Fix"], ["revalidate", f.ref, "#13", "--fits", "2", "--files", "src/a.mjs"], ["revalidate", f.ref, "#13", "--adds", "Fix", "--files", "a.mjs,"]]) {
    assert.equal(runPlan(f.config, args, f.deps), 2, JSON.stringify(args));
    assert.equal(f.text(), PLAN_FIXTURE);
  }
});
test("a folder read reports the OS read error", (t) => {
  const f = fixture(t);
  assert.equal(runPlan(f.config, ["check", "docs/plans"], f.deps), 1);
  assert.match(f.err.join("\n"), /qc plan:.*(?:EISDIR|EPERM|EACCES)/);
});
test("store read and write failures return one refusal", (t) => {
  const f = fixture(t);
  for (const args of [["check", f.ref], ["new", "12", "demo"]]) {
    assert.equal(runPlan(f.config, args, {...f.deps,store:{list:()=>[], read:()=>{throw new Error("read failed");}, write:()=>{throw new Error("write failed");}}}), 1);
  }
  assert.match(f.err.join("\n"), /read failed/);
  assert.match(f.err.join("\n"), /write failed/);
});
test("lead approves None services and done is idempotent", (t) => {
  const f = fixture(t, {}, planWith([[/### PlanStore[\s\S]*?(?=\n## Catalog)/, "None: existing code only.\n"], ["services 1", "services 0"]]));
  assert.equal(runPlan(f.config, ["approve", f.ref, "--by", "lead"], f.deps), 0);
  assert.equal(runPlan(f.config, ["done", f.ref, "2"], f.deps), 0);
  const before = f.text();
  assert.equal(runPlan(f.config, ["done", f.ref, "2"], f.deps), 0);
  assert.equal(f.text(), before);
  runPlan(f.config, ["status", f.ref], f.deps);
  assert.match(f.out.join("\n"), /next none/);
});
