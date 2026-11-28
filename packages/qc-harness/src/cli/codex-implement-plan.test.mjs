import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DONE_MARKER, runCodexImplement } from "./codex-implement.mjs";
import { PLAN_FIXTURE } from "./plan-fixture.mjs";
const quiet = () => {};
const PLAN_BRIEF = "# Brief\nPlan: `docs/plans/12-demo.md`\nTask: `2`\nPaths: `src/features/demo/trigger.mjs`, `src/features/demo/trigger.test.mjs`\n\n## Product decisions\n- Use the local rules.\n\n## Task\n1. Do task one.\n";
function setup(t, config = {}, {plan, brief = PLAN_BRIEF.replace(/^Plan:.*\nTask:.*\n/m, "")} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "qc-implement-plan-"));
  t.after(() => rmSync(root, {recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const worktree=path.join(root,"wt"), progress=path.join(root,"progress.md"), briefFile=path.join(root,"brief.md");
  mkdirSync(path.join(worktree,"docs/plans"), {recursive:true});
  writeFileSync(path.join(worktree,"qc.config.json"),JSON.stringify(config));
  writeFileSync(progress,""); writeFileSync(briefFile,brief);
  if (plan) writeFileSync(path.join(worktree,"docs/plans/12-demo.md"),plan);
  const git = (...args) => execFileSync("git",args,{cwd:worktree,encoding:"utf8",stdio:["ignore","pipe","pipe"]});
  git("init","-q"); git("config","user.name","Test"); git("config","user.email","test@example.com");
  git("add","."); git("commit","-qm","test: seed");
  return {worktree,progress,git,argv:["--brief",briefFile,"--worktree",worktree,"--progress",progress]};
}
test("requirePlan refuses an implement brief without Plan: and never runs Codex", async (t) => {
  const f = setup(t, { codex: { requirePlan: true } });
  let calls = 0;
  assert.equal(await runCodexImplement(f.argv, { say: quiet, out: quiet, run: async () => ((calls += 1), { status: 0, tail: "" }) }), 1);
  assert.equal(calls, 0);
});
test("requirePlan starts an implement brief whose task is open", async (t) => {
  const f = setup(t, { codex: { requirePlan: true } }, { plan: PLAN_FIXTURE, brief: PLAN_BRIEF });
  assert.equal(await runCodexImplement(f.argv, { say: quiet, out: quiet, run: async () => (appendFileSync(f.progress, DONE_MARKER), { status: 0, tail: "" }) }), 0);
});
test("Plan: stands in for Approved: when requireApproval and requirePlan are on", async (t) => {
  const f = setup(t, { codex: { requirePlan: true, requireApproval: true } }, { plan: PLAN_FIXTURE, brief: `${PLAN_BRIEF}\n## Design\n- none\n` });
  assert.equal(await runCodexImplement(f.argv, { say: quiet, out: quiet, run: async () => (appendFileSync(f.progress, DONE_MARKER), { status: 0, tail: "" }) }), 0);
});
test("the review role skips the gate", async (t) => {
  const f = setup(t, { codex: { requirePlan: true } });
  const messages = [];
  await runCodexImplement([...f.argv, "--review"], { say: (line) => messages.push(line), out: quiet, run: async () => ({ status: 0, tail: "" }) });
  assert.ok(!messages.some((line) => /Plan: is required/.test(line)));
});
test("a run that edits the plan file exits 4", async (t) => {
  const f = setup(t, { codex: {} }, { plan: PLAN_FIXTURE, brief: PLAN_BRIEF.replace(/^Paths:.*$/m, "Paths: `.`") });
  const messages = [];
  const code = await runCodexImplement(f.argv, { say: (line) => messages.push(line), out: quiet, run: async () => (appendFileSync(path.join(f.worktree, "docs/plans/12-demo.md"), "edit\n"), { status: 0, tail: "" }) });
  assert.equal(code, 4);
  assert.match(messages.join("\n"), /changed docs\/plans\/12-demo\.md/);
});
for (const replacement of ["", "Plan: `docs/plans/other.md`\n"]) test(`the plan edit guard keeps the initial reference when the child changes Plan to ${replacement.trim() || "empty"}`, async (t) => {
  const brief = PLAN_BRIEF.replace(/^Paths:.*$/m, "Paths: `docs/plans/12-demo.md`");
  const f = setup(t, { codex: {} }, { plan: PLAN_FIXTURE, brief });
  const messages = [];
  const code = await runCodexImplement(f.argv, { say: (line) => messages.push(line), out: quiet, run: async () => {
    appendFileSync(path.join(f.worktree, "docs/plans/12-demo.md"), "edit\n");
    writeFileSync(f.argv[1], brief.replace(/^Plan:.*\n/m, replacement));
    appendFileSync(f.progress, DONE_MARKER);
    return { status: 0, tail: "" };
  }});
  assert.equal(code, 4);
  assert.match(messages.join("\n"), /changed docs\/plans\/12-demo\.md/);
});
test("codex.requirePlan must be a boolean", async (t) => {
  const f = setup(t, { codex: { requirePlan: "yes" } });
  const messages = [];
  assert.equal(await runCodexImplement(f.argv, { say: (line) => messages.push(line), out: quiet }), 1);
  assert.match(messages.join("\n"), /codex.requirePlan in qc.config.json must be a boolean/);
});
test("fix rounds skip plan checks and still run", async (t) => {
  const f = setup(t, {codex:{requirePlan:true}}, {brief:PLAN_BRIEF.replace(/^Plan:.*\nTask:.*\n/m, "Proof: `review.md`\n")});
  let calls = 0;
  assert.equal(await runCodexImplement(f.argv, {say:quiet,out:quiet,run:async()=>{calls++; appendFileSync(f.progress,DONE_MARKER); return {status:0,tail:""};}}),0);
  assert.equal(calls,1);
});
test("Plan does not replace Approved when requirePlan is off", async (t) => {
  const f = setup(t,{codex:{requireApproval:true}}, {plan:PLAN_FIXTURE,brief:PLAN_BRIEF+"\n## Design\n- No new service.\n"});
  const messages=[];
  assert.equal(await runCodexImplement(f.argv,{say:(line)=>messages.push(line),out:quiet,run:async()=>assert.fail("must refuse before Codex")}),1);
  assert.match(messages.join("\n"),/Approved: is required/);
});
test("Plan still needs Design when requireApproval is on", async (t) => {
  const f=setup(t,{codex:{requirePlan:true,requireApproval:true}},{plan:PLAN_FIXTURE,brief:PLAN_BRIEF});
  const messages=[];
  assert.equal(await runCodexImplement(f.argv,{say:(line)=>messages.push(line),out:quiet}),1);
  assert.match(messages.join("\n"),/## Design is required/);
});
for (const mode of ["staged","committed"]) test(`the plan edit guard catches ${mode} edits in fix rounds`, async (t) => {
  const f=setup(t,{codex:{requirePlan:true}},{plan:PLAN_FIXTURE,brief:PLAN_BRIEF+"Proof: `review.md`\n"});
  const messages=[];
  assert.equal(await runCodexImplement(f.argv,{say:(line)=>messages.push(line),out:quiet,run:async()=>{
    appendFileSync(path.join(f.worktree,"docs/plans/12-demo.md"),"edit\n");
    f.git("add","docs/plans/12-demo.md");
    if(mode === "committed") f.git("commit","-qm","docs: edit plan");
    return {status:0,tail:""};
  }}),4);
  assert.match(messages.join("\n"),/guard refused: the run changed/);
});
