import { PLAN_FIXTURE } from "./plan-fixture.mjs";
import { parsePlanDoc, taskDone } from "./plan-parse.mjs";
import { tickTask } from "./plan-edit.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCodexLoop } from "./codex-loop.mjs";

function setup(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-loop-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  writeFileSync(path.join(dir, "implement.md"), `# Brief: test\nWorktree: \`${dir}\`\nIssue: \`#0\`\nPaths: \`src/\`\nReport: \`${dir}/implement-report.md\`\nProgress: \`${dir}/implement-progress.md\`\nVerify: none\nApproved: \`spec.md\`\n## Task\n1. Work.\n## Commit\nCommit only.\n`);
  return dir;
}
for (const mode of ["approve", "fix", "exhaust", "limit", "from-review", "review-limit", "bad-exit"]) {
  test(`codex-loop ${mode} status and exit`, async t => {
    const dir = setup(t), calls = [];
    const result = await runCodexLoop(["--dir", dir, "--brief", "implement.md", "--rounds", "2", "--base", "origin/topic", ...(mode === "from-review" ? ["--from-review", path.join(dir, "prior.md")] : [])], {
      warn: () => {}, git: async (_root, ...args) => ({ stdout: args[0] === "rev-parse" ? "a".repeat(40) : "outside.mjs\0" }),
      implement: async args => {
        calls.push(args);
        if (mode === "limit") return 2;
        if (mode === "bad-exit") return 1;
        if (args.includes("--review")) {
          if (mode === "review-limit") return 2;
          const changes = mode === "exhaust" || (mode === "fix" && calls.length === 2);
          writeFileSync(args[args.indexOf("--report") + 1], `VERDICT: ${changes ? "CHANGES_REQUIRED" : "APPROVED"}\n`);
        }
        return 0;
      },
    });
    const status = readFileSync(path.join(dir, "loop.status"), "utf8");
    assert.equal(result, mode.includes("limit") ? 2 : ["exhaust", "bad-exit"].includes(mode) ? 1 : 0);
    if (mode === "limit") assert.equal(status, "implement exit 2\nSTOP LIMIT implement\n");
    if (mode === "exhaust") assert.match(status, /STOP 2 rounds without approval\n$/);
    if (mode === "bad-exit") assert.match(status, /STOP implement exit 1/);
    if (mode === "fix") assert.match(status, /loop-fix-1 exit 0\nloop-review-2 exit 0 APPROVED\nDONE APPROVED/);
    if (mode === "approve") {
      assert.equal(status, "implement exit 0\nloop-review-1 exit 0 APPROVED\nDONE APPROVED\n");
      const review = readFileSync(path.join(dir, "loop-review-1.md"), "utf8");
      assert.match(review, /origin\/topic\.\.\./);
      assert.match(review, /outside.mjs/);
      assert.match(review, /Make no commit and no push/);
    }
    if (mode === "from-review") {
      assert.match(status, /^loop-fix-0 exit 0/);
      assert.match(readFileSync(path.join(dir, "loop-fix-0.md"), "utf8"), /prior.md/);
    }
  });
}
for (const exit of [1, 2, 4, 7, 42]) test(`codex-loop rejects approval when review exits ${exit}`, async t => {
  const dir = setup(t);
  let calls = 0;
  const code = await runCodexLoop(["--dir", dir, "--brief", "implement.md", "--skip-implement"], {
    git: async (_cwd, ...args) => ({ stdout: args[0] === "rev-parse" ? "a".repeat(40) : "" }),
    implement: async args => {
      calls++;
      assert.ok(args.includes("--review"));
      writeFileSync(args[args.indexOf("--report") + 1], "VERDICT: APPROVED\n");
      return exit;
    },
  });
  assert.equal(code, exit === 2 ? 2 : 1);
  assert.equal(calls, 1);
  assert.equal(readFileSync(path.join(dir, "loop.status"), "utf8"),
    `loop-review-1 exit ${exit} APPROVED\n${exit === 2 ? "STOP LIMIT loop-review-1" : `STOP loop-review-1 exit ${exit}`}\n`);
});
for (const mode of ["fix", "from-review"]) test(`codex-loop ${mode} links proof without approval metadata`, async t => {
  const dir = setup(t), briefs = new Map();
  const source = path.join(dir, "implement.md"), prior = path.join(dir, "prior.md");
  writeFileSync(source, readFileSync(source, "utf8").replace(/^Approved: .*\n/m, ""));
  const code = await runCodexLoop(["--dir", dir, "--brief", "implement.md",
    ...(mode === "from-review" ? ["--from-review", prior] : [])], {
    git: async (_cwd, ...args) => ({ stdout: args[0] === "rev-parse" ? "a".repeat(40) : "" }),
    implement: async args => {
      const file = args[args.indexOf("--brief") + 1], name = path.basename(file);
      briefs.set(name, readFileSync(file, "utf8"));
      if (args.includes("--review")) writeFileSync(args[args.indexOf("--report") + 1],
        `VERDICT: ${mode === "fix" && name === "loop-review-1.md" ? "CHANGES_REQUIRED" : "APPROVED"}\n`);
      return 0;
    },
  });
  assert.equal(code, 0);
  const links = mode === "fix"
    ? [["loop-review-1", "implement-report.md"], ["loop-fix-1", "loop-review-1-report.md"], ["loop-review-2", "loop-fix-1-report.md"]]
    : [["loop-fix-0", "prior.md"], ["loop-review-1", "loop-fix-0-report.md"]];
  for (const [name, proof] of links) {
    const text = briefs.get(`${name}.md`);
    assert.equal(text.match(/^Proof: .*$/gm)?.length, 1, `${name} needs one Proof line`);
    assert.ok(text.includes(`Proof: \`${path.join(dir, proof)}\``), name);
    assert.doesNotMatch(text, /^Approved:/m);
  }
});
test("codex-loop invalid arguments exit 2", async () => {
  assert.equal(await runCodexLoop(["--rounds", "0"], { warn: () => {} }), 2);
});
test("skip implement archives stale proof and keeps wrapper output; review defaults to origin/main", async t => {
  const dir = setup(t);
  writeFileSync(path.join(dir, "loop-review-1-report.md"), "VERDICT: APPROVED\n");
  writeFileSync(path.join(dir, "loop-review-1-progress.md"), "stale progress\n");
  let calls = 0;
  const code = await runCodexLoop(["--dir", dir, "--brief", "implement.md", "--skip-implement"], {
    clock: () => 123, git: async (_cwd, ...args) => ({ stdout: args[0] === "rev-parse" ? "a".repeat(40) : "" }),
    implement: async (args, options) => {
      calls++; assert.ok(args.includes("--review"));
      assert.equal(readFileSync(path.join(dir, "old-123-loop-review-1-report.md"), "utf8"), "VERDICT: APPROVED\n");
      options.say("review output");
      writeFileSync(args[args.indexOf("--report") + 1], "VERDICT: APPROVED\n");
      return 0;
    },
  });
  assert.equal(code, 0); assert.equal(calls, 1);
  assert.equal(readFileSync(path.join(dir, "loop-review-1.wrapper"), "utf8"), "review output\n");
  assert.match(readFileSync(path.join(dir, "loop-review-1.md"), "utf8"), /origin\/main\.\.\./);
});
function planSetup(t, text = PLAN_FIXTURE) {
  const dir = setup(t);
  const brief = path.join(dir, "implement.md");
  writeFileSync(brief, readFileSync(brief,"utf8").replace("Issue: `#0`", "Issue: `#12`").replace(/^Paths:.*$/m, "Paths: `.`\nPlan: `docs/plans/12-demo.md`\nTask: `2`"));
  mkdirSync(path.join(dir,"docs/plans"),{recursive:true});
  writeFileSync(path.join(dir,"docs/plans/12-demo.md"), text);
  return dir;
}
function fakeGit(calls = []) {
  return async (_root,...args) => { calls.push(args); return {stdout: args[0] === "rev-parse" ? "a".repeat(40) : args[0] === "diff" ? "src/features/demo/trigger.mjs\0src/other.mjs\0" : ""}; };
}
async function approve(args) {
  if (args.includes("--review")) writeFileSync(args[args.indexOf("--report")+1],"VERDICT: APPROVED\n");
  return 0;
}
test("codex-loop puts plan notes in the review brief", async (t) => {
  const dir = planSetup(t);
  await runCodexLoop(["--dir", dir, "--brief", "implement.md", "--rounds", "1"], { warn: () => {}, git: fakeGit(), implement: approve });
  const review = readFileSync(path.join(dir, "loop-review-1.md"), "utf8");
  assert.match(review, /Plan drift: files outside Task 2/);
  assert.match(review, /Plan check: compare the diff with Task 2/);
});
test("codex-loop ticks the task and commits on DONE APPROVED", async (t) => {
  const dir = planSetup(t), calls = [];
  assert.equal(await runCodexLoop(["--dir", dir, "--brief", "implement.md", "--rounds", "1"], { warn: () => {}, git: fakeGit(calls), implement: approve }), 0);
  assert.ok(taskDone(parsePlanDoc(readFileSync(path.join(dir, "docs/plans/12-demo.md"), "utf8")).tasks[1]));
  assert.equal(calls.some((args) => args[0] === "add"), false);
  assert.deepEqual(calls.find((args) => args[0] === "commit"), ["commit", "-m", "docs(plan): mark task 2 done", "-m", "Refs #12", "--only", "--", "docs/plans/12-demo.md"]);
  assert.match(readFileSync(path.join(dir, "loop.status"), "utf8"), /PLAN DONE Task 2\nDONE APPROVED\n$/);
});
test("codex-loop makes no commit when the task is already ticked", async (t) => {
  const dir = planSetup(t, tickTask(PLAN_FIXTURE, 2)), calls = [];
  await runCodexLoop(["--dir", dir, "--brief", "implement.md", "--rounds", "1"], { warn: () => {}, git: fakeGit(calls), implement: approve });
  assert.equal(calls.some((args) => args[0] === "commit"), false);
});
test("codex-loop stops when the tick commit fails", async (t) => {
  const dir = planSetup(t);
  const git = async (root, ...args) => { if (args[0] === "commit") throw new Error("hook refused"); return fakeGit()(root, ...args); };
  assert.equal(await runCodexLoop(["--dir", dir, "--brief", "implement.md", "--rounds", "1"], { warn: () => {}, git, implement: approve }), 1);
  assert.match(readFileSync(path.join(dir, "loop.status"), "utf8"), /STOP plan tick: hook refused/);
});
for (const stagedPlan of [false, true]) test(`a refused tick commit restores the plan and index, then a skip retry commits it (staged plan: ${stagedPlan})`, async (t) => {
  const { execFileSync } = await import("node:child_process");
  const dir = planSetup(t), ref = "docs/plans/12-demo.md", file = path.join(dir, ref);
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
  git("add", ref); git("commit", "-qm", "test: seed");
  if (stagedPlan) {
    writeFileSync(file, PLAN_FIXTURE.replace("Ship the demo.", "Ship the demo with tests."));
    git("add", ref);
  }
  const before = readFileSync(file, "utf8") + "\nLocal note.\n";
  writeFileSync(file, before);
  writeFileSync(path.join(dir, "other.mjs"), "other\n"); git("add", "other.mjs");
  const indexBefore = git("ls-files", "--stage"), headBefore = git("rev-parse", "HEAD");
  const hooks = path.join(dir, "hooks"); mkdirSync(hooks);
  writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  git("config", "core.hooksPath", hooks);
  const args = ["--dir", dir, "--brief", "implement.md", "--base", "HEAD"];
  const options = { warn: () => {}, git: async (_root, ...args) => ({ stdout: git(...args) }), implement: approve };
  assert.equal(await runCodexLoop(args, options), 1);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(git("ls-files", "--stage"), indexBefore);
  assert.equal(git("rev-parse", "HEAD"), headBefore);
  writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 0\n");
  assert.equal(await runCodexLoop([...args, "--skip-implement"], { ...options, implement: async (args) => {
    assert.ok(args.includes("--review"));
    return approve(args);
  }}), 0);
  assert.notEqual(git("rev-parse", "HEAD"), headBefore);
  assert.equal(git("show", `HEAD:${ref}`), tickTask(before, 2));
  assert.equal(git("diff", "--cached", "--name-only").trim(), "other.mjs");
  assert.match(readFileSync(path.join(dir, "loop.status"), "utf8"), /PLAN DONE Task 2\nDONE APPROVED\n$/);
});
test("plan tick attribution follows the config", async (t) => {
  const dir=planSetup(t), calls=[];
  writeFileSync(path.join(dir,"qc.config.json"),JSON.stringify({commitMessage:{attribution:true}}));
  assert.equal(await runCodexLoop(["--dir",dir,"--brief","implement.md"],{warn:()=>{},git:fakeGit(calls),implement:approve}),0);
  assert.ok(calls.find((args)=>args[0]==="commit").includes("Co-Authored-By: Codex <noreply@openai.com>"));
});
test("the tick commit leaves other staged files for their owner", async (t) => {
  const {execFileSync} = await import("node:child_process");
  const dir=planSetup(t);
  const git=(...args)=>execFileSync("git",args,{cwd:dir,encoding:"utf8",stdio:["ignore","pipe","pipe"]});
  git("init","-q"); git("config","user.name","Test"); git("config","user.email","test@example.com");
  git("add","docs/plans/12-demo.md"); git("commit","-qm","test: seed");
  writeFileSync(path.join(dir,"other.mjs"),"other\n"); git("add","other.mjs");
  const result=await runCodexLoop(["--dir",dir,"--brief","implement.md","--base","HEAD"],{warn:()=>{},git:async(_root,...args)=>({stdout:git(...args)}),implement:approve});
  assert.equal(result,0);
  assert.equal(git("diff-tree","--no-commit-id","--name-only","-r","HEAD").trim(),"docs/plans/12-demo.md");
  assert.equal(git("diff","--cached","--name-only").trim(),"other.mjs");
});
