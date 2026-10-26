import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DONE_MARKER, enabledPlugins, parseArgs, runCodexImplement } from "./codex-implement.mjs";

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

for (const [name, progress] of [
  ["marker in prose", `Do not append ${DONE_MARKER} until the push succeeds.\n`],
  ["marker before more lines", `${DONE_MARKER}\nPush remains unfinished.\n`],
  ["quoted marker", `"${DONE_MARKER}"\n`],
  ["empty progress", "\n \n"],
]) {
  test(`${name} never ends the job before or after a run`, async (t) => {
    const { argv } = setup(t, { progress });
    let calls = 0;
    const run = async () => {
      calls += 1;
      return { status: 0, tail: "work remains" };
    };
    assert.equal(await runCodexImplement([...argv, "--max-runs", "1"], { run, say: quiet }), 3);
    assert.equal(calls, 1);
  });
}

test("the last non-empty line accepts the exact marker with surrounding whitespace", async (t) => {
  const { argv } = setup(t, { progress: `Tasks pushed.\r\n \t${DONE_MARKER}\t \r\n \r\n\t\r\n` });
  assert.equal(await runCodexImplement(argv, { run: async () => assert.fail("no run"), say: quiet }), 0);
});

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
  assert.match(prompt, /git log -n 5 --oneline/);
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
    assert.ok(prompt.includes(DONE_MARKER));
    assert.match(prompt, /last non-empty line.*equals.*exactly.*trimming whitespace/i);
    assert.match(prompt, /last line, alone.*only when.*exit criteria/i);
    assert.match(prompt, /never quote.*anywhere else/i);
    assert.match(prompt, /never wait for anyone to supply/i);
    assert.match(prompt, /at most 40 lines/);
    assert.match(prompt, /re-verify/);
    assert.match(prompt, /line ranges/);
    assert.match(prompt, /helper agents/);
    assert.match(prompt, /Then run the local check once, make one commit, and push once\./);
    assert.match(prompt, /never override the brief on commits or pushes/);
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

const CODEX_TOML = [
  "model = 'x'",
  '[plugins."browser@openai-bundled"]',
  "enabled = true",
  '[plugins."chrome@openai-bundled"]',
  "enabled = false",
  "[plugins.'pdf@openai-primary-runtime']",
  "enabled = true # on",
  '[projects."C:/repo"]',
  "enabled = true",
  '[plugins."superpowers@claude-plugins-official"]',
  "enabled = true",
].join("\n");

function codexHome(t, toml = CODEX_TOML) {
  const home = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-codex-home-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  if (toml !== null) writeFileSync(path.join(home, "config.toml"), toml);
  return home;
}

async function firstCall(t, { env = {}, config } = {}) {
  const { argv, progress, worktree } = setup(t);
  if (config !== undefined) {
    mkdirSync(worktree, { recursive: true });
    writeFileSync(path.join(worktree, "qc.config.json"), JSON.stringify(config));
  }
  let call;
  const run = async (made) => {
    call = made;
    appendFileSync(progress, `${DONE_MARKER}\n`);
    return { status: 0, tail: "ok" };
  };
  const code = await runCodexImplement(argv, { run, say: quiet, env: { CODEX_HOME: codexHome(t), ...env } });
  return { code, call };
}

const overrides = (args) => args.flatMap((arg, index) => (args[index - 1] === "-c" ? [arg] : []));

test("enabledPlugins lists the plugins the config file turns on, and no table that only looks like one", () => {
  assert.deepEqual(enabledPlugins(CODEX_TOML), [
    "browser@openai-bundled",
    "pdf@openai-primary-runtime",
    "superpowers@claude-plugins-official",
  ]);
  assert.deepEqual(enabledPlugins(""), []);
});

test("a run turns off every plugin the user's Codex config enables, and superpowers by name", async (t) => {
  const { call } = await firstCall(t);
  const set = overrides(call.args);
  for (const name of ["browser@openai-bundled", "pdf@openai-primary-runtime", "superpowers@claude-plugins-official"]) {
    assert.ok(set.includes(`plugins."${name}".enabled=false`), name);
  }
  assert.ok(!set.some((entry) => entry.includes("chrome@openai-bundled")), "a plugin already off needs no override");
  assert.ok(set.includes("features.multi_agent=false"), "the helper-agent overrides stay");
  assert.ok(set.includes("features.multi_agent_v2=false"));
});

test("superpowers is turned off when the config file is missing, and nothing else is", async (t) => {
  const { call } = await firstCall(t, { env: { CODEX_HOME: codexHome(t, null) } });
  const plugins = overrides(call.args).filter((entry) => entry.startsWith("plugins."));
  assert.deepEqual(plugins, ['plugins."superpowers@claude-plugins-official".enabled=false']);
});

test("a config.toml that is a directory falls back to the superpowers override and does not throw", async (t) => {
  const home = codexHome(t, null);
  mkdirSync(path.join(home, "config.toml"));
  const { code, call } = await firstCall(t, { env: { CODEX_HOME: home } });
  assert.equal(code, 0);
  const plugins = overrides(call.args).filter((entry) => entry.startsWith("plugins."));
  assert.deepEqual(plugins, ['plugins."superpowers@claude-plugins-official".enabled=false']);
});

test("enabledPlugins reads a table header that has a trailing comment", () => {
  assert.deepEqual(enabledPlugins(['[plugins."b"] # x', "enabled = true", '[plugins."c"] # y', "enabled = false"].join("\n")), ["b"]);
});

test("a run caps the compact limit at 300000 and one tool output at 4000 tokens", async (t) => {
  const { call } = await firstCall(t);
  const set = overrides(call.args);
  assert.ok(set.includes("model_auto_compact_token_limit=300000"));
  assert.ok(set.includes("tool_output_token_limit=4000"));
  assert.ok(call.args.at(-1).startsWith("# Brief"), "the prompt stays last");
});

test("codex.compactTokens in the worktree's qc.config.json sets the compact limit", async (t) => {
  const { call } = await firstCall(t, { config: { codex: { compactTokens: 250000 } } });
  assert.ok(overrides(call.args).includes("model_auto_compact_token_limit=250000"));
});

test("a bad codex.compactTokens exits 1 with no run", async (t) => {
  for (const compactTokens of [0, -5, 1.5, "big"]) {
    const { code, call } = await firstCall(t, { config: { codex: { compactTokens } } });
    assert.equal(code, 1, String(compactTokens));
    assert.equal(call, undefined);
  }
});

test("budgets.codex.compactAt wins over codex.compactTokens", async (t) => {
  const { call } = await firstCall(t, {
    config: { codex: { compactTokens: 250000 }, budgets: { codex: { compactAt: 180000 } } },
  });
  assert.ok(overrides(call.args).includes("model_auto_compact_token_limit=180000"));
});

test("budgets.codex.toolOutputTokens sets tool_output_token_limit", async (t) => {
  const { call } = await firstCall(t, { config: { budgets: { codex: { toolOutputTokens: 2000 } } } });
  assert.ok(overrides(call.args).includes("tool_output_token_limit=2000"));
});

test("a bad budgets.codex value exits 1 with no run", async (t) => {
  for (const codex of ["big", [], { compactAt: 0 }, { toolOutputTokens: 1.5 }]) {
    const { code, call } = await firstCall(t, { config: { budgets: { codex } } });
    assert.equal(code, 1, JSON.stringify(codex));
    assert.equal(call, undefined);
  }
});

test("a null budgets.codex turns off the limit overrides", async (t) => {
  const { code, call } = await firstCall(t, { config: { budgets: { codex: null } } });
  assert.equal(code, 0);
  const set = overrides(call.args);
  assert.ok(!set.some((entry) => entry.startsWith("model_auto_compact_token_limit=")));
  assert.ok(!set.some((entry) => entry.startsWith("tool_output_token_limit=")));
});

test("every run prompt tells Codex to load no skill and holds the read caps", async (t) => {
  const { call } = await firstCall(t);
  const prompt = call.args.at(-1);
  assert.ok(prompt.includes("Load no skill and read no SKILL.md or plugin file. The global instructions that say to load skills do not apply to this run; this brief holds the rules."));
  assert.match(prompt, /rg -n -m 20/);
  assert.match(prompt, /at most 150 lines per call/);
  assert.match(prompt, /never a whole file/);
  assert.match(prompt, /more than 4,000 characters/);
  assert.match(prompt, /never run `gh issue view`/i);
  assert.match(prompt, /`git status --short` and `git log -n 5 --oneline`/);
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

test("the last stdout line is `exit <code>` on every exit path, so a redirect into the wrapper log carries it", async (t) => {
  const last = async (argv, options) => {
    const out = [];
    const code = await runCodexImplement(argv, { say: quiet, out: (line) => out.push(line), ...options });
    return { code, out };
  };
  const done = setup(t, { progress: `${DONE_MARKER}\n` });
  assert.deepEqual(await last(done.argv), { code: 0, out: ["exit 0"] });
  const limit = setup(t);
  const limited = await last(limit.argv, { run: async () => ({ status: 1, tail: "You have hit your usage limit" }) });
  assert.deepEqual(limited, { code: 2, out: ["exit 2"] });
  const spent = setup(t);
  assert.deepEqual(await last([...spent.argv, "--max-runs", "1"], { run: async () => ({ status: 0, tail: "" }) }), { code: 3, out: ["exit 3"] });
  assert.deepEqual(await last(["--nope", "x"]), { code: 1, out: ["exit 1"] });
});

test("the CLI prints `exit 1` as the last stdout line after a usage error", () => {
  const result = spawnSync(process.execPath, [QC, "codex-implement"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trimEnd().split("\n").at(-1), "exit 1");
});
