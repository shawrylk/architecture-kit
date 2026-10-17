import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DONE_MARKER, parseArgs, runCodexImplement } from "./codex-implement.mjs";

const QC = fileURLToPath(new URL("./qc.mjs", import.meta.url));

function setup(t, { progress = "" } = {}) {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-codex-implement-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = { dir, brief: path.join(dir, "brief.md"), progress: path.join(dir, "progress.md"), worktree: path.join(dir, "wt") };
  writeFileSync(files.brief, "# Brief\n\nDo task one.\n");
  writeFileSync(files.progress, progress);
  const argv = ["--brief", files.brief, "--worktree", files.worktree, "--progress", files.progress];
  return { ...files, argv };
}

const quiet = () => {};

test("a progress file that already says ALL TASKS DONE exits 0 with no run", async (t) => {
  const { argv } = setup(t, { progress: `task 1 committed\n${DONE_MARKER}\n` });
  let calls = 0;
  const code = await runCodexImplement(argv, { run: async () => (calls += 1), say: quiet });
  assert.equal(code, 0);
  assert.equal(calls, 0);
});

test("a run passes exec, the sandbox, the worktree and one prompt, with QC_ROLE=implementer", async (t) => {
  const { argv, brief, progress, worktree } = setup(t);
  const seen = [];
  const run = async (call) => {
    seen.push(call);
    appendFileSync(progress, `${DONE_MARKER}\n`);
    return { status: 0, tail: "ok" };
  };
  assert.equal(await runCodexImplement(argv, { run, say: quiet }), 0);
  assert.equal(seen.length, 1);
  const [call] = seen;
  assert.equal(call.command, "codex");
  assert.deepEqual(call.args.slice(0, 5), ["exec", "-s", "danger-full-access", "-C", worktree]);
  const prompt = call.args.at(-1);
  assert.equal(call.env.QC_ROLE, "implementer");
  assert.ok(prompt.startsWith(readFileSync(brief, "utf8")));
  assert.match(prompt, /git log --oneline/);
  assert.match(prompt, /git status --short/);
  assert.match(prompt, /first unfinished task/);
  assert.ok(prompt.includes(progress));
  assert.equal(call.log, `${progress}.log`);
});

test("the brief is read again before each run, so an edit reaches the next session", async (t) => {
  const { argv, brief, progress } = setup(t);
  const prompts = [];
  const run = async (call) => {
    prompts.push(call.args.at(-1));
    if (prompts.length === 1) writeFileSync(brief, "# Brief\n\nDo task one.\nDecision: use the new column name.\n");
    else appendFileSync(progress, `${DONE_MARKER}\n`);
    return { status: 0, tail: "ok" };
  };
  assert.equal(await runCodexImplement(argv, { run, say: quiet }), 0);
  assert.equal(prompts.length, 2);
  assert.ok(!prompts[0].includes("new column name"));
  assert.ok(prompts[1].includes("Decision: use the new column name."));
});

test("every run prompt carries the lean rules after the brief", async (t) => {
  const { argv, brief, progress } = setup(t);
  const seen = [];
  const run = async (call) => {
    seen.push(call.args.at(-1));
    if (seen.length === 2) appendFileSync(progress, `${DONE_MARKER}\n`);
    return { status: 0, tail: "ok" };
  };
  assert.equal(await runCodexImplement(argv, { run, say: quiet }), 0);
  assert.equal(seen.length, 2);
  for (const prompt of seen) {
    assert.ok(prompt.startsWith(readFileSync(brief, "utf8")));
    assert.match(prompt, /at most 40 lines/);
    assert.match(prompt, /re-verify/);
    assert.match(prompt, /line ranges/);
    assert.match(prompt, /helper agents/);
    assert.match(prompt, /Then run the local check once, make one commit, and push once\./);
    assert.match(prompt, /npx qc gate-slot --/);
    assert.match(prompt, /npx qc throwaway-db --/);
    assert.match(prompt, /Never use port 5432/);
    assert.match(prompt, /at most 15 files before the first code edit/i);
    assert.match(prompt, /under 15 lines/);
    assert.match(prompt, /never drop a security, tenant, data, or correctness check/i);
  }
});

test("a run turns off the Codex helper agents with -c, before the prompt", async (t) => {
  const { argv, progress } = setup(t);
  let args;
  const run = async (call) => {
    args = call.args;
    appendFileSync(progress, `${DONE_MARKER}\n`);
    return { status: 0, tail: "ok" };
  };
  assert.equal(await runCodexImplement(argv, { run, say: quiet }), 0);
  const index = args.indexOf("features.multi_agent=false");
  assert.ok(index > 0 && args[index - 1] === "-c");
  assert.ok(index < args.length - 1, "the prompt stays the last argument");
});

test("a fresh session starts after a stop with the progress file not done", async (t) => {
  const { argv, progress } = setup(t);
  let calls = 0;
  const run = async () => {
    calls += 1;
    if (calls === 2) appendFileSync(progress, `${DONE_MARKER}\n`);
    return { status: 0, tail: "context large, notes written" };
  };
  assert.equal(await runCodexImplement(argv, { run, say: quiet }), 0);
  assert.equal(calls, 2);
});

test("a usage or spend limit in the output tail exits 2 and stops restarting", async (t) => {
  const { argv } = setup(t);
  for (const message of ["You've hit your usage limit.", "Spend cap reached", "429 Rate Limit exceeded", "you HIT YOUR LIMIT"]) {
    let calls = 0;
    const run = async () => {
      calls += 1;
      return { status: 1, tail: `stack\n${message}\n` };
    };
    assert.equal(await runCodexImplement(argv, { run, say: quiet }), 2, message);
    assert.equal(calls, 1, message);
  }
});

test("--max-runs bounds the restarts and exits 3, with a default of 12", async (t) => {
  const { argv } = setup(t);
  let calls = 0;
  const run = async () => ((calls += 1), { status: 0, tail: "stopped" });
  assert.equal(await runCodexImplement([...argv, "--max-runs", "3"], { run, say: quiet }), 3);
  assert.equal(calls, 3);
  calls = 0;
  assert.equal(await runCodexImplement(argv, { run, say: quiet }), 3);
  assert.equal(calls, 12);
});

test("a run that finishes the brief on its last allowed run exits 0, not 3", async (t) => {
  const { argv, progress } = setup(t);
  const run = async () => (appendFileSync(progress, DONE_MARKER), { status: 0, tail: "" });
  assert.equal(await runCodexImplement([...argv, "--max-runs", "1"], { run, say: quiet }), 0);
});

test("a codex binary that does not start exits 1 with the reason", async (t) => {
  const { argv } = setup(t);
  const said = [];
  const run = async () => {
    throw new Error("spawn codex ENOENT");
  };
  assert.equal(await runCodexImplement(argv, { run, say: (line) => said.push(line) }), 1);
  assert.match(said.join("\n"), /ENOENT/);
});

test("a missing or malformed argument exits 1 and names it", async (t) => {
  const { argv } = setup(t);
  const said = [];
  const run = async () => assert.fail("no run");
  for (const bad of [[], argv.slice(2), [...argv, "--max-runs", "0"], [...argv, "--max-runs", "x"], [...argv, "--nope", "1"]]) {
    assert.equal(await runCodexImplement(bad, { run, say: (line) => said.push(line) }), 1, bad.join(" "));
  }
  assert.match(said.join("\n"), /--brief/);
  assert.match(said.join("\n"), /--max-runs/);
  assert.match(said.join("\n"), /--nope/);
});

test("parseArgs reads the flags, resolves the paths, and puts the log beside the progress file", () => {
  const parsed = parseArgs(["--brief", "b.md", "--worktree", "w", "--progress", "p/progress.md", "--log", "x.log", "--max-runs", "5"]);
  assert.equal(parsed.maxRuns, 5);
  assert.equal(parsed.log, path.resolve("x.log"));
  assert.equal(parsed.brief, path.resolve("b.md"));
  assert.equal(parseArgs(["--brief", "b", "--worktree", "w", "--progress", "p/q.md"]).log, `${path.resolve("p/q.md")}.log`);
});

test("the default runner spawns without a shell, closes stdin, and appends output to the log", async (t) => {
  const { dir, argv, progress, brief } = setup(t);
  const fake = path.join(dir, "fake-codex.mjs");
  writeFileSync(
    fake,
    [
      'import { appendFileSync } from "node:fs";',
      "let input = '';",
      "for await (const chunk of process.stdin) input += chunk;",
      "console.log(JSON.stringify({ args: process.argv.slice(2), role: process.env.QC_ROLE, input }));",
      `if (process.env.FAKE_MODE === "limit") console.error("You have hit your usage limit");`,
      `else appendFileSync(${JSON.stringify(progress)}, ${JSON.stringify(`${DONE_MARKER}
`)});`,
    ].join("\n"),
  );
  const log = path.join(dir, "run.log");
  const done = await runCodexImplement([...argv, "--log", log], { codexCommand: [process.execPath, fake], say: quiet });
  assert.equal(done, 0);
  const line = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]);
  assert.equal(line.role, "implementer");
  assert.equal(line.input, "");
  assert.deepEqual(line.args.slice(0, 3), ["exec", "-s", "danger-full-access"]);
  assert.ok(line.args.at(-1).startsWith(readFileSync(brief, "utf8")));

  writeFileSync(progress, "");
  process.env.FAKE_MODE = "limit";
  t.after(() => delete process.env.FAKE_MODE);
  assert.equal(await runCodexImplement([...argv, "--log", log], { codexCommand: [process.execPath, fake], say: quiet }), 2);
  assert.ok(readFileSync(log, "utf8").split("\n").filter((entry) => entry.startsWith("{")).length >= 2, "the log is appended, not replaced");
});

test("qc codex-implement is wired, and prints usage errors with exit 1", () => {
  const result = spawnSync(process.execPath, [QC, "codex-implement"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--brief/);
  assert.match(spawnSync(process.execPath, [QC], { encoding: "utf8" }).stdout, /qc codex-implement/);
});

test("a limit word that only echoes the brief is not a limit", async (t) => {
  const { argv, brief } = setup(t);
  writeFileSync(brief, "# Brief\n\nIf you hit a usage limit, stop and write notes.\n");
  let calls = 0;
  const run = async () => {
    calls += 1;
    return { status: 1, tail: "user\nIf you hit a usage limit, stop and write notes.\nexec failed\n" };
  };
  assert.equal(await runCodexImplement([...argv, "--max-runs", "2"], { run, say: quiet }), 3);
  assert.equal(calls, 2);
});
