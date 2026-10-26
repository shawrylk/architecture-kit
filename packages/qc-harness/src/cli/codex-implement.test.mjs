import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DONE_MARKER, enabledPlugins, parseArgs, runCodexImplement } from "./codex-implement.mjs";

const QC = fileURLToPath(new URL("./qc.mjs", import.meta.url));
const VALID_BRIEF = "# Brief\nPaths: src/example.mjs\n\n## Product decisions\n- Use the local rules.\n\n## Task\n1. Do task one.\n";
const FIXED_PREAMBLE = "The brief carries every rule. Load no skill. Write no `Grammar:` line.";
const limitDir = mkdtempSync(path.join(os.tmpdir(), "qc-codex-implement-limit-"));
const previousLimitFile = process.env.QC_CODEX_LIMIT_FILE;
process.env.QC_CODEX_LIMIT_FILE = path.join(limitDir, "limit.json");
after(() => {
  if (previousLimitFile === undefined) delete process.env.QC_CODEX_LIMIT_FILE;
  else process.env.QC_CODEX_LIMIT_FILE = previousLimitFile;
  rmSync(limitDir, { recursive: true, force: true });
});
const T = Date.UTC(2026, 9, 26);

function setup(t, { progress = "" } = {}) {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-codex-implement-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = { dir, brief: path.join(dir, "brief.md"), progress: path.join(dir, "progress.md"), worktree: path.join(dir, "wt") };
  writeFileSync(files.brief, VALID_BRIEF);
  writeFileSync(files.progress, progress);
  const argv = ["--brief", files.brief, "--worktree", files.worktree, "--progress", files.progress];
  return { ...files, argv };
}

const quiet = () => {};

function resetClock() {
  let time = Date.parse("2026-01-01T00:00:00.000Z");
  const sleeps = [];
  return { now: () => time, sleeps, sleep: async (ms) => { sleeps.push(ms); time += ms; } };
}

test("--wait-reset resumes the same brief and progress after the second poll", async (t) => {
  const { argv, progress } = setup(t);
  const timer = resetClock();
  const calls = [];
  let polls = 0;
  const run = async (call) => {
    calls.push(call);
    if (calls.length === 1) return { status: 2, tail: "usage limit" };
    appendFileSync(progress, `${DONE_MARKER}\n`);
    return { status: 0, tail: "done" };
  };
  const fetch = async () => {
    assert.equal(calls.length, 1, "the wait never starts a model");
    polls += 1;
    return { ok: true, json: async () => ({ data: { latest_reset: {
      announced_at: polls === 1 ? "2026-01-01T00:00:00.000Z" : "2026-01-01T00:15:00.000Z",
    } } }) };
  };
  const exits = [];
  assert.equal(await runCodexImplement([...argv, "--wait-reset"], { run, fetch, ...timer, say: quiet, out: (line) => exits.push(line) }), 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].input, calls[1].input);
  assert.equal(calls[0].log, calls[1].log);
  assert.deepEqual(timer.sleeps, [15 * 60 * 1000]);
  assert.deepEqual(exits, ["exit 0"]);
});

test("--wait-reset exits two at its bound without another model call", async (t) => {
  const { argv } = setup(t);
  const timer = resetClock();
  let runs = 0;
  const exits = [];
  const code = await runCodexImplement([...argv, "--wait-reset", "--max-hours", "0.3"], {
    ...timer, say: quiet, out: (line) => exits.push(line),
    run: async () => { runs += 1; return { status: 1, tail: "usage limit" }; },
    fetch: async () => ({ ok: true, json: async () => ({ data: { latest_reset: { announced_at: "2025-12-31T23:00:00.000Z" } } }) }),
  });
  assert.equal(code, 2);
  assert.equal(runs, 1);
  assert.equal(timer.now(), Date.parse("2026-01-01T00:18:00.000Z"));
  assert.deepEqual(exits, ["exit 2"]);
});

test("repeated limits share one wait bound and use each limit's timestamp", async (t) => {
  const { argv } = setup(t);
  const timer = resetClock();
  let runs = 0;
  let polls = 0;
  const code = await runCodexImplement([...argv, "--wait-reset", "--max-hours", "0.5"], {
    ...timer, say: quiet, out: quiet,
    run: async () => {
      runs += 1;
      if (runs === 2) await timer.sleep(1);
      return { status: 2, tail: "" };
    },
    fetch: async () => {
      polls += 1;
      return { ok: true, json: async () => ({ data: { latest_reset: {
        announced_at: polls === 1 ? "2025-12-31T23:00:00.000Z" : "2026-01-01T00:15:00.000Z",
      } } }) };
    },
  });
  assert.equal(code, 2);
  assert.equal(runs, 2);
  assert.equal(timer.now(), Date.parse("2026-01-01T00:30:00.000Z"));
});

test("a limit without --wait-reset exits two without fetching", async (t) => {
  const { argv } = setup(t);
  assert.equal(await runCodexImplement(argv, {
    say: quiet, out: quiet,
    run: async () => ({ status: 2, tail: "" }),
    fetch: async () => assert.fail("no fetch"),
  }), 2);
});

test("parseArgs accepts the wait flag among value flags and validates the bound", () => {
  const argv = ["--brief", "b", "--worktree", "w", "--progress", "p"];
  assert.equal(parseArgs(argv).waitReset, false);
  assert.equal(parseArgs(argv).maxHours, 6);
  const parsed = parseArgs(["--wait-reset", ...argv, "--max-hours", "0.5"]);
  assert.equal(parsed.waitReset, true);
  assert.equal(parsed.maxHours, 0.5);
  for (const hours of ["0", "-1", "NaN", "Infinity"]) {
    assert.throws(() => parseArgs([...argv, "--max-hours", hours]), /--max-hours/);
  }
});

test("the Windows CLI resumes after fetch and returns without a forced exit", { skip: process.platform !== "win32" }, (t) => {
  const { dir, argv, progress } = setup(t);
  const attempt = path.join(dir, "attempt");
  const fake = path.join(dir, "fake.mjs");
  writeFileSync(fake, `import { existsSync, writeFileSync, appendFileSync } from 'node:fs';
    for await (const chunk of process.stdin) {}
    if (existsSync(${JSON.stringify(attempt)})) appendFileSync(${JSON.stringify(progress)}, ${JSON.stringify(DONE_MARKER)});
    else { writeFileSync(${JSON.stringify(attempt)}, '1'); console.error('usage limit'); process.exitCode = 2; }`);
  writeFileSync(path.join(dir, "codex.cmd"), `@echo off\r\n@"${process.execPath}" "${fake}" %*\r\n`);
  const cli = new URL("./qc.mjs", import.meta.url).href;
  const source = `globalThis.fetch = async () => {
      console.error('fake reset fetch');
      return { ok: true, json: async () => ({ data: { latest_reset: { announced_at: new Date(Date.now() + 1000).toISOString() } } }) };
    };
    process.exit = () => { throw new Error('forced exit after fetch'); };
    process.argv = [process.execPath, ${JSON.stringify(QC)}, 'codex-implement', ...${JSON.stringify(argv)}, '--wait-reset'];
    await import(${JSON.stringify(cli)});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8", timeout: 10000, env: { ...process.env, PATH: dir, PATHEXT: ".EXE;.CMD" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /fake reset fetch/);
  assert.equal(result.stdout.trim(), "exit 0");
});

test("an unreadable progress path reports the error and writes exit 1", async (t) => {
  const { argv, progress } = setup(t);
  rmSync(progress);
  mkdirSync(progress);
  const lines = [];
  const messages = [];
  const code = await runCodexImplement(argv, {
    run: async () => assert.fail("no run"),
    say: (line) => messages.push(line),
    out: (line) => lines.push(line),
  });
  assert.equal(code, 1);
  assert.deepEqual(lines, ["exit 1"]);
  assert.match(messages.join("\n"), /qc codex-implement:.*EISDIR/);
});

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
  const prompt = call.input;
  assert.equal(call.args.at(-1), "-");
  assert.equal(call.env.QC_ROLE, "implementer");
  assert.ok(prompt.startsWith(`${FIXED_PREAMBLE}\n\n${readFileSync(brief, "utf8")}`));
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
    prompts.push(call.input);
    if (prompts.length === 1) writeFileSync(brief, VALID_BRIEF + "Decision: use the new column name.\n");
    else appendFileSync(progress, `${DONE_MARKER}\n`);
    return { status: 0, tail: "ok" };
  };
  assert.equal(await runCodexImplement([...argv, "--max-runs", "2"], { run, say: quiet }), 0);
  assert.equal(prompts.length, 2);
  assert.ok(!prompts[0].includes("new column name"));
  assert.ok(prompts[1].includes("Decision: use the new column name."));
});

test("every run prompt carries the lean rules after the brief", async (t) => {
  const { argv, brief, progress } = setup(t);
  const seen = [];
  const run = async (call) => {
    seen.push(call.input);
    if (seen.length === 2) appendFileSync(progress, `${DONE_MARKER}\n`);
    return { status: 0, tail: "ok" };
  };
  assert.equal(await runCodexImplement([...argv, "--max-runs", "2"], { run, say: quiet }), 0);
  assert.equal(seen.length, 2);
  for (const prompt of seen) {
    assert.ok(prompt.startsWith(`${FIXED_PREAMBLE}\n\n${readFileSync(brief, "utf8")}`));
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

test("the fixed preamble precedes the configured lines and the brief", async (t) => {
  const preamble = "Use the repository's rules.\nKeep the task small.";
  const { code, call } = await firstCall(t, { config: { codex: { preamble } } });
  assert.equal(code, 0);
  assert.ok(call.input.startsWith(`${FIXED_PREAMBLE}\n${preamble}\n\n${VALID_BRIEF}`));
});

test("codex.disablePlugins merges configured and enabled plugins without duplicates", async (t) => {
  const { code, call } = await firstCall(t, { config: { codex: {
    disablePlugins: ["custom@plugins", "browser@openai-bundled", "custom@plugins"],
  } } });
  assert.equal(code, 0);
  assert.deepEqual(overrides(call.args).filter((entry) => entry.startsWith("plugins.")).sort(), [
    'plugins."browser@openai-bundled".enabled=false',
    'plugins."custom@plugins".enabled=false',
    'plugins."pdf@openai-primary-runtime".enabled=false',
    'plugins."superpowers@claude-plugins-official".enabled=false',
  ]);
});

test("an empty codex.disablePlugins replaces the default list", async (t) => {
  const { call } = await firstCall(t, { env: { CODEX_HOME: codexHome(t, null) }, config: { codex: { disablePlugins: [] } } });
  assert.deepEqual(overrides(call.args).filter((entry) => entry.startsWith("plugins.")), []);
});

for (const [name, brief, flags, message] of [
  ["too many non-blank lines", VALID_BRIEF + "line\n".repeat(41), [], /codex\.briefMaxLines.*40/],
  ["multiple tasks", VALID_BRIEF + "## Another task\nDo more.\n", [], /task heading.*1/],
  ["too many task steps", VALID_BRIEF + Array.from({ length: 6 }, (_, i) => `${i + 2}. More work.\n`).join(""), [], /codex\.briefMaxSteps.*6/],
  ["missing product decisions", VALID_BRIEF.replace("## Product decisions", "Decisions"), [], /Product decisions.*required.*1/],
  ["missing paths", VALID_BRIEF.replace("Paths: src/example.mjs", ""), [], /Paths:.*required.*1/],
  ["empty paths", VALID_BRIEF.replace("Paths: src/example.mjs", "Paths:   "), [], /Paths:.*required.*1/],
  ["too many runs", VALID_BRIEF, ["--max-runs", "3"], /--max-runs.*codex\.maxRuns.*2/],
]) {
  test(`${name} refuses the brief before Codex starts and names the limit`, async (t) => {
    const { argv, brief: file } = setup(t);
    writeFileSync(file, brief);
    const messages = [];
    const out = [];
    assert.equal(await runCodexImplement([...argv, ...flags], {
      run: async () => assert.fail("Codex must not start"),
      say: (line) => messages.push(line),
      out: (line) => out.push(line),
    }), 1);
    assert.match(messages.join("\n"), message);
    assert.deepEqual(out, ["exit 1"]);
  });
}

test("blank lines and the template's fixed sections use no task or task-step budget", async (t) => {
  const { argv, brief, progress } = setup(t);
  const lines = [VALID_BRIEF, "## Run shape", ...Array.from({ length: 7 }, (_, i) => `${i + 1}. Follow the run rules.`),
    "## Commit", "Use the commit rule.", "## Exit criteria", "- Finish the task."];
  while (lines.join("\n").split("\n").filter((line) => line.trim()).length < 40) lines.push("Detail.");
  writeFileSync(brief, lines.join("\n\n\n"));
  assert.equal(await runCodexImplement(argv, {
    say: quiet,
    run: async () => (appendFileSync(progress, DONE_MARKER), { status: 0, tail: "" }),
  }), 0);
});

test("the unchanged brief template passes the default limits", async (t) => {
  const { argv, brief, progress } = setup(t);
  writeFileSync(brief, readFileSync(new URL("../../../../skills/codex/brief-template.md", import.meta.url), "utf8"));
  assert.equal(await runCodexImplement(argv, {
    say: quiet,
    run: async () => (appendFileSync(progress, DONE_MARKER), { status: 0, tail: "" }),
  }), 0);
});

test("repository settings raise each brief and run limit", async (t) => {
  const { argv, brief, worktree } = setup(t);
  mkdirSync(worktree);
  writeFileSync(path.join(worktree, "qc.config.json"), JSON.stringify({ codex: { briefMaxLines: 60, briefMaxSteps: 7, maxRuns: 3 } }));
  writeFileSync(brief, VALID_BRIEF + Array.from({ length: 6 }, (_, i) => `${i + 2}. More work.\n`).join("") + "Detail.\n".repeat(35));
  let calls = 0;
  assert.equal(await runCodexImplement([...argv, "--max-runs", "3"], {
    say: quiet,
    run: async () => ((calls += 1), { status: 0, tail: "" }),
  }), 3);
  assert.equal(calls, 3);
});

test("an edited brief must pass the limits before the next run", async (t) => {
  const { argv, brief } = setup(t);
  let calls = 0;
  const messages = [];
  assert.equal(await runCodexImplement([...argv, "--max-runs", "2"], {
    say: (line) => messages.push(line),
    run: async () => {
      calls += 1;
      writeFileSync(brief, VALID_BRIEF + "## More work\n");
      return { status: 0, tail: "" };
    },
  }), 1);
  assert.equal(calls, 1);
  assert.match(messages.join("\n"), /task heading.*1/);
});

test("invalid Codex settings refuse the run and name the setting", async (t) => {
  for (const key of ["briefMaxLines", "briefMaxSteps", "maxRuns"]) {
    for (const value of [0, -1, 1.5, "6", null]) {
      const { code, call } = await firstCall(t, { config: { codex: { [key]: value } } });
      assert.equal(code, 1, `${key}=${value}`);
      assert.equal(call, undefined);
    }
  }
  for (const codex of [{ preamble: [] }, { preamble: null }, { disablePlugins: "plugin" }, { disablePlugins: [1] }, { disablePlugins: [""] }]) {
    const { code, call } = await firstCall(t, { config: { codex } });
    assert.equal(code, 1, JSON.stringify(codex));
    assert.equal(call, undefined);
  }
});

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
  assert.ok(call.input.startsWith(FIXED_PREAMBLE), "the prompt uses stdin");
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
  const prompt = call.input;
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

test("exit 2 writes the limit state with the reset time of the Codex line", async (t) => {
  const { argv, dir } = setup(t);
  const file = path.join(dir, "limit.json");
  const run = async () => ({ status: 1, tail: "You have hit your usage limit. Try again in 2 hours 13 minutes." });
  assert.equal(await runCodexImplement(argv, { run, say: quiet, env: { QC_CODEX_LIMIT_FILE: file }, now: () => T }), 2);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    until: new Date(T + 133 * 60_000).toISOString(), source: "codex", recordedAt: new Date(T).toISOString(),
  });
});

test("exit 2 writes now plus 60 minutes when the line names no time", async (t) => {
  const { argv, dir } = setup(t);
  const file = path.join(dir, "limit.json");
  const run = async () => ({ status: 1, tail: "You have hit your usage limit" });
  assert.equal(await runCodexImplement(argv, { run, say: quiet, env: { QC_CODEX_LIMIT_FILE: file }, now: () => T }), 2);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    until: new Date(T + 3_600_000).toISOString(), source: "default", recordedAt: new Date(T).toISOString(),
  });
});

test("a limit line echoed from the prompt writes no limit state", async (t) => {
  const { argv, dir, brief } = setup(t);
  const file = path.join(dir, "limit.json");
  const line = "You have hit your usage limit. Try again in 2 hours 13 minutes.";
  writeFileSync(brief, `${VALID_BRIEF}${line}\n`);
  const run = async () => ({ status: 1, tail: `user\n${line}\nexec failed` });
  assert.equal(await runCodexImplement([...argv, "--max-runs", "1"], { run, say: quiet, env: { QC_CODEX_LIMIT_FILE: file }, now: () => T }), 3);
  assert.equal(existsSync(file), false);
});

test("a limit-state write error reports the reason and preserves exit 2", async (t) => {
  const { argv, dir } = setup(t);
  const file = path.join(dir, "blocked", "limit.json");
  writeFileSync(path.dirname(file), "blocks the directory");
  const said = [];
  const run = async () => ({ status: 1, tail: "You have hit your usage limit" });
  assert.equal(await runCodexImplement(argv, { run, say: (line) => said.push(line), env: { QC_CODEX_LIMIT_FILE: file }, now: () => T }), 2);
  assert.match(said.join("\n"), /cannot write.*limit/i);
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

test("the default runner sends the prompt, closes stdin, and appends output to the log", async (t) => {
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
  assert.ok(line.input.startsWith(`${FIXED_PREAMBLE}\n\n${readFileSync(brief, "utf8")}`));
  assert.deepEqual(line.args.slice(0, 3), ["exec", "-s", "danger-full-access"]);
  assert.equal(line.args.at(-1), "-");
  assert.ok(line.args.every((arg) => !/[\r\n]/.test(arg)));

  writeFileSync(progress, "");
  process.env.FAKE_MODE = "limit";
  t.after(() => delete process.env.FAKE_MODE);
  assert.equal(await runCodexImplement([...argv, "--log", log], { codexCommand: [process.execPath, fake], say: quiet }), 2);
  assert.ok(readFileSync(log, "utf8").split("\n").filter((entry) => entry.startsWith("{")).length >= 2, "the log is appended, not replaced");
});

test("an immediate Codex exit accepts a closed stdin pipe with a 200 KB prompt", async (t) => {
  const { dir, argv, brief } = setup(t);
  writeFileSync(brief, VALID_BRIEF + "x".repeat(200 * 1024));
  const fake = path.join(dir, "exit-codex.mjs");
  writeFileSync(fake, "process.exit(0);");
  const messages = [];
  const lines = [];
  const code = await runCodexImplement([...argv, "--max-runs", "1"], {
    codexCommand: [process.execPath, fake],
    say: (line) => messages.push(line),
    out: (line) => lines.push(line),
  });
  assert.equal(code, 3, messages.join("\n"));
  assert.deepEqual(lines, ["exit 3"]);
  assert.doesNotMatch(messages.join("\n"), /codex did not run/);
  assert.match(messages.join("\n"), /run 1 ended with status 0/);
});

test("the default runner resolves a Windows command shim", { skip: process.platform !== "win32" }, async (t) => {
  const { dir, argv, progress, brief } = setup(t);
  const prompt = VALID_BRIEF + "\r\nFirst line.\nSecond line: Ti\u1ebfng Vi\u1ec7t.\n" + "long line ".repeat(1000);
  writeFileSync(brief, prompt);
  const received = path.join(dir, "received.json");
  const fake = path.join(dir, "fake.mjs");
  writeFileSync(fake, `import { appendFileSync, writeFileSync } from "node:fs";
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) input += chunk;
    writeFileSync(${JSON.stringify(received)}, JSON.stringify({ input, args: process.argv.slice(2) }));
    appendFileSync(${JSON.stringify(progress)}, ${JSON.stringify(DONE_MARKER)});`);
  writeFileSync(path.join(dir, "fake-codex.cmd"), `@echo off\r\n@"${process.execPath}" "${fake}" %*\r\n`);
  assert.equal(await runCodexImplement(argv, {
    codexCommand: ["fake-codex"],
    env: { ...process.env, PATH: dir, PATHEXT: ".EXE;.CMD" },
    say: quiet,
  }), 0);
  const result = JSON.parse(readFileSync(received, "utf8"));
  assert.ok(result.input.startsWith(`${FIXED_PREAMBLE}\n\n${prompt}`));
  assert.equal(result.args.at(-1), "-");
  assert.ok(result.args.every((arg) => !/[\r\n]/.test(arg)));
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
