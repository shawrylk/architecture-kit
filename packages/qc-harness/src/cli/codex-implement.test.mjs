import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DONE_MARKER, parseArgs, runCodexImplement } from "./codex-implement.mjs";

const QC = fileURLToPath(new URL("./qc.mjs", import.meta.url));
const VALID_BRIEF = "# Brief\nPaths: src/task.mjs\n\n## Product decisions\nKeep the change small.\n\n## Task\n1. Implement the change.\n";

function setup(t, { progress = "", brief = VALID_BRIEF, codex } = {}) {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-codex-implement-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = { dir, brief: path.join(dir, "brief.md"), progress: path.join(dir, "progress.md"), worktree: path.join(dir, "wt") };
  mkdirSync(files.worktree);
  writeFileSync(files.brief, brief);
  if (codex) writeFileSync(path.join(files.worktree, "qc.config.json"), JSON.stringify({ codex }));
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
  assert.equal(call.args.length, 6);
  assert.equal(call.env.QC_ROLE, "implementer");
  assert.ok(call.args[5].startsWith(readFileSync(brief, "utf8")));
  assert.match(call.args[5], /git log --oneline/);
  assert.match(call.args[5], /git status --short/);
  assert.match(call.args[5], /first unfinished task/);
  assert.ok(call.args[5].includes(progress));
  assert.equal(call.log, `${progress}.log`);
});

test("a fresh session starts after a stop with the progress file not done", async (t) => {
  const { argv, progress } = setup(t);
  let calls = 0;
  const run = async () => {
    calls += 1;
    if (calls === 2) appendFileSync(progress, `${DONE_MARKER}\n`);
    return { status: 0, tail: "context large, notes written" };
  };
  assert.equal(await runCodexImplement([...argv, "--max-runs", "2"], { run, say: quiet }), 0);
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

test("--max-runs bounds the restarts and exits 3, with a default of 1", async (t) => {
  const { argv } = setup(t);
  let calls = 0;
  const run = async () => ((calls += 1), { status: 0, tail: "stopped" });
  assert.equal(await runCodexImplement([...argv, "--max-runs", "2"], { run, say: quiet }), 3);
  assert.equal(calls, 2);
  calls = 0;
  assert.equal(await runCodexImplement(argv, { run, say: quiet }), 3);
  assert.equal(calls, 1);
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
  assert.ok(line.args[5].startsWith(readFileSync(brief, "utf8")));

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
  writeFileSync(brief, VALID_BRIEF + "If you hit a usage limit, stop and write notes.\n");
  let calls = 0;
  const run = async () => {
    calls += 1;
    return { status: 1, tail: "user\nIf you hit a usage limit, stop and write notes.\nexec failed\n" };
  };
  assert.equal(await runCodexImplement([...argv, "--max-runs", "2"], { run, say: quiet }), 3);
  assert.equal(calls, 2);
});

async function assertRefused(argv, rule, limit, measured) {
  const said = [];
  let calls = 0;
  const run = async () => ((calls += 1), { status: 0, tail: "stopped" });
  const code = await runCodexImplement(argv, { run, say: (line) => said.push(line) });
  assert.equal(code, 1);
  assert.equal(calls, 0);
  const message = said.join("\n");
  assert.ok(message.includes(rule), message);
  assert.match(message, new RegExp(`limit[^\\n]*${limit}\\b`));
  assert.match(message, new RegExp(`measured[^\\n]*${measured}\\b`));
}

test("a brief above codex.briefMaxLines is refused before Codex starts", async (t) => {
  const { argv } = setup(t, { brief: VALID_BRIEF + "More detail.\n".repeat(35) });
  await assertRefused(argv, "codex.briefMaxLines", 40, 41);
  const custom = setup(t, { codex: { briefMaxLines: 5 } });
  await assertRefused(custom.argv, "codex.briefMaxLines", 5, 6);
});

test("a brief with more than one task heading is refused before Codex starts", async (t) => {
  const { argv } = setup(t, { brief: VALID_BRIEF + "## Another task\n" });
  await assertRefused(argv, "task-headings", 1, 2);
});

test("a brief above codex.briefMaxSteps is refused before Codex starts", async (t) => {
  const { argv } = setup(t, { brief: VALID_BRIEF + "2. More work.\n".repeat(6) });
  await assertRefused(argv, "codex.briefMaxSteps", 6, 7);
  const custom = setup(t, { brief: VALID_BRIEF + "2) More work.\n", codex: { briefMaxSteps: 1 } });
  await assertRefused(custom.argv, "codex.briefMaxSteps", 1, 2);
});

test("a brief without a Product decisions heading is refused before Codex starts", async (t) => {
  const { argv } = setup(t, { brief: VALID_BRIEF.replace("## Product decisions\n", "") });
  await assertRefused(argv, "product-decisions", 1, 0);
});

test("a brief without a Paths line is refused before Codex starts", async (t) => {
  for (const paths of ["", "Paths:   \n"]) {
    const { argv } = setup(t, { brief: VALID_BRIEF.replace("Paths: src/task.mjs\n", paths) });
    await assertRefused(argv, "paths", 1, 0);
  }
});

test("--max-runs above codex.maxRuns is refused before Codex starts", async (t) => {
  const { argv } = setup(t);
  await assertRefused([...argv, "--max-runs", "3"], "codex.maxRuns", 2, 3);
  const custom = setup(t, { codex: { maxRuns: 1 } });
  await assertRefused([...custom.argv, "--max-runs", "2"], "codex.maxRuns", 1, 2);
});

test("a brief at every default boundary passes with blank lines and CRLF", async (t) => {
  const brief = ["# Brief", "Paths: src/task.mjs", "## Product decisions", "## Task", ...Array.from({ length: 6 }, (_, i) => `${i + 1}. Do one step.`), ...Array(30).fill("Detail.")].join("\r\n\r\n");
  const { argv, progress } = setup(t, { brief });
  const run = async () => (appendFileSync(progress, DONE_MARKER), { status: 0, tail: "ok" });
  assert.equal(await runCodexImplement(argv, { run, say: quiet }), 0);
});

test("the worktree config can raise the brief and run limits", async (t) => {
  const brief = VALID_BRIEF + "2. More work.\n".repeat(6) + "Detail.\n".repeat(29);
  const { argv } = setup(t, { brief, codex: { briefMaxLines: 41, briefMaxSteps: 7, maxRuns: 3 } });
  let calls = 0;
  const run = async () => ((calls += 1), { status: 0, tail: "stopped" });
  assert.equal(await runCodexImplement([...argv, "--max-runs", "3"], { run, say: quiet }), 3);
  assert.equal(calls, 3);
});
