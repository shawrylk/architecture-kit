import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runtimeModels } from "../config.mjs";
import { CODEX_LINE, REMINDER, WORKER_NOTE, decide, modelsLine } from "./dispatch-reminder.mjs";

// The checkouts below run under Codex, whatever runtime runs the test.
process.env.QC_RUNTIME = "codex";
delete process.env.QC_ROLE;
const BASE = `${REMINDER}${modelsLine({ models: runtimeModels.codex, runtime: "codex" })}${CODEX_LINE}`;

const NOTE = fileURLToPath(new URL("./dispatch-reminder.mjs", import.meta.url));
const HOOKS = fileURLToPath(new URL("../../../../hooks/hooks.json", import.meta.url));

/** Three checkouts: one per config, and `null` writes no config at all. */
function checkouts(t, configs) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-dispatch-note-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return configs.map((config, index) => {
    const dir = path.join(base, String(index));
    mkdirSync(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" });
    if (config !== null) writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify(config));
    return dir;
  });
}

const start = (cwd, source) => ({ session_id: "s", cwd, hook_event_name: "SessionStart", source });
const subagentStart = (cwd) => ({ session_id: "s", cwd, hook_event_name: "SubagentStart", agent_type: "sonnet-implementer" });

test("a checkout with no config, or no dispatch section, gets no note", (t) => {
  const [plain, off] = checkouts(t, [null, { swarm: { toolCallBudget: 50 } }]);
  assert.equal(decide(start(plain, "startup")), null);
  assert.equal(decide(start(off, "startup")), null);
});

test("with the section on, every start adds the note, a compaction included", (t) => {
  const [on] = checkouts(t, [{ swarm: { direct: false, dispatch: {} } }]);
  for (const source of ["startup", "resume", "clear", "compact", "fork"]) {
    const output = decide(start(on, source));
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart", source);
    assert.equal(output.hookSpecificOutput.additionalContext, BASE, source);
  }
});

test("the note names the workflow, the four types, and the one-implementer rule, in a short text", () => {
  for (const word of [
    "superpowers:subagent-driven-development",
    "architecture:sdd-planner",
    "architecture:sdd-implementer",
    "architecture:sdd-reviewer",
    "architecture:sdd-branch-reviewer",
    "one implementer at a time",
    "Worktree: <path>",
    "VERDICT: <APPROVED|CHANGES_REQUIRED> <sha>",
    "--match-head-commit <sha>",
  ]) {
    assert.ok(REMINDER.includes(word), word);
  }
  assert.ok(REMINDER.length < 1300, `${REMINDER.length} characters`);
});

test("the note says to review a green head only, to fix CI first, and to review a fix round by its increment", () => {
  for (const phrase of [
    /only once CI on it is green/,
    /fix a CI failure first/,
    /`Reviewed: <sha>`/,
    /review each fix round once, by its increment/,
    /product questions first, in one question/,
    /`## Product decisions`/,
    /merge `origin\/<base>` at Step 0 of a fix round/,
    /A PR gets one branch review/,
  ]) {
    assert.match(REMINDER, phrase);
  }
});

test("with swarm.explore also on, the note names its tools", (t) => {
  const [on] = checkouts(t, [
    { swarm: { dispatch: {}, explore: { tools: [{ name: "CocoIndex", use: "u", how: "h" }, { name: "GitNexus", use: "u", how: "h" }] } } },
  ]);
  const text = decide(start(on, "startup")).hookSpecificOutput.additionalContext;
  assert.ok(text.startsWith(BASE));
  assert.match(text, /CocoIndex, GitNexus/);
  assert.match(text, /optional/i);
});

test("with swarm.explore off, or naming no tools, the note is exactly the base note", (t) => {
  const [off, empty] = checkouts(t, [
    { swarm: { direct: false, dispatch: {} } },
    { swarm: { direct: false, dispatch: {}, explore: { tools: [] } } },
  ]);
  assert.equal(decide(start(off, "startup")).hookSpecificOutput.additionalContext, BASE);
  assert.equal(decide(start(empty, "startup")).hookSpecificOutput.additionalContext, BASE);
});

test("with swarm.explore on and swarm.dispatch off, the SessionStart note still names the tools", (t) => {
  const [on] = checkouts(t, [{ swarm: { explore: { tools: [{ name: "CocoIndex", use: "u", how: "h" }] } } }]);
  const output = decide(start(on, "startup"));
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(output.hookSpecificOutput.additionalContext, /CocoIndex/);
  assert.match(output.hookSpecificOutput.additionalContext, /optional/i);
  assert.ok(!output.hookSpecificOutput.additionalContext.startsWith(" "));
});

test("SubagentStart names the tools when swarm.explore is on, independent of swarm.dispatch", (t) => {
  const [on] = checkouts(t, [{ swarm: { explore: { tools: [{ name: "CocoIndex", use: "u", how: "h" }] } } }]);
  const output = decide(subagentStart(on));
  assert.equal(output.hookSpecificOutput.hookEventName, "SubagentStart");
  assert.match(output.hookSpecificOutput.additionalContext, /CocoIndex/);
  assert.match(output.hookSpecificOutput.additionalContext, /optional/i);
});

test("SubagentStart with no swarm.explore section, or none naming tools, is a no-op", (t) => {
  const [plain, off, empty] = checkouts(t, [null, { swarm: { dispatch: {} } }, { swarm: { explore: { tools: [] } } }]);
  assert.equal(decide(subagentStart(plain)), null);
  assert.equal(decide(subagentStart(off)), null);
  assert.equal(decide(subagentStart(empty)), null);
});

test("a config error reaches the session as context", (t) => {
  const [bad] = checkouts(t, [{ swarm: { dispatch: { maxPromptChars: "long" } } }]);
  assert.match(decide(start(bad, "startup")).hookSpecificOutput.additionalContext, /Dispatch guard is off/);
});

test("the hook runs as its own process and prints the note as JSON, or nothing with no config", (t) => {
  const [on, plain] = checkouts(t, [{ swarm: { direct: false, dispatch: {} } }, null]);
  const run = (cwd) => spawnSync(process.execPath, [NOTE], { input: JSON.stringify(start(cwd, "startup")), encoding: "utf8" });
  const noted = run(on);
  assert.equal(noted.status, 0, noted.stderr);
  assert.equal(JSON.parse(noted.stdout).hookSpecificOutput.additionalContext, BASE);
  const silent = run(plain);
  assert.equal(silent.status, 0, silent.stderr);
  assert.equal(silent.stdout, "");
});

test("hooks.json runs the note on every SessionStart source", () => {
  const { hooks } = JSON.parse(readFileSync(HOOKS, "utf8"));
  const entries = (hooks.SessionStart ?? []).filter((entry) =>
    entry.hooks.some((hook) => hook.command.includes("dispatch-reminder.mjs")),
  );
  assert.deepEqual(entries.map((entry) => entry.matcher), [undefined]);
});

test("hooks.json also runs the note on SubagentStart, all matchers, beside the existing entry", () => {
  const { hooks } = JSON.parse(readFileSync(HOOKS, "utf8"));
  const entries = hooks.SubagentStart ?? [];
  const noteEntries = entries.filter((entry) => entry.hooks.some((hook) => hook.command.includes("dispatch-reminder.mjs")));
  assert.deepEqual(noteEntries.map((entry) => entry.matcher), [undefined]);
  assert.ok(
    entries.some((entry) => entry.hooks.some((hook) => hook.command.includes("dispatch-guard.mjs"))),
    "the existing dispatch-guard.mjs SubagentStart entry stays",
  );
});

test("a limit above 1 adds one line stating it, and a limit of 1 leaves the note as the base note", (t) => {
  const [three, one] = checkouts(t, [
    { swarm: { dispatch: { implementerSlots: 3 } } },
    { swarm: { direct: false, dispatch: { implementerSlots: 1 } } },
  ]);
  const text = decide(start(three, "startup")).hookSpecificOutput.additionalContext;
  assert.ok(text.startsWith(BASE));
  assert.match(text, /up to 3 implementers at once/);
  assert.equal(decide(start(one, "startup")).hookSpecificOutput.additionalContext, BASE);
});

test("SubagentStart gives each tool's use and command, in config order, since a plugin agent carries no MCP tool", (t) => {
  const [on] = checkouts(t, [
    {
      swarm: {
        explore: {
          tools: [
            { name: "CocoIndex", use: "find the files for a concept", how: 'ccc search "<question>"' },
            { name: "GitNexus", use: "callers and callees", how: "gitnexus context <symbol> -r repo" },
          ],
        },
      },
    },
  ]);
  assert.equal(
    decide(subagentStart(on)).hookSpecificOutput.additionalContext,
    [
      "Optional explore tools, and how to run each. Read, Grep, and shell searches remain available:",
      '- CocoIndex: find the files for a concept (ccc search "<question>")',
      "- GitNexus: callers and callees (gitnexus context <symbol> -r repo)",
    ].join("\n"),
  );
});

test("a swarm.explore section that does not parse leaves SubagentStart silent and the session note as the base note", (t) => {
  const [bad] = checkouts(t, [{ swarm: { direct: false, dispatch: {}, explore: { tools: "CocoIndex" } } }]);
  assert.equal(decide(subagentStart(bad)), null);
  assert.equal(decide(start(bad, "startup")).hookSpecificOutput.additionalContext, BASE);
});

test("with the direct lane on by default, the note names its limits after the base note", (t) => {
  const [lane, custom] = checkouts(t, [{ swarm: { dispatch: {} } }, { swarm: { dispatch: {}, direct: { maxLines: 5, maxFiles: 1 } } }]);
  const text = decide(start(lane, "startup")).hookSpecificOutput.additionalContext;
  assert.ok(text.startsWith(BASE));
  assert.match(text, /at most 20 changed lines in 2 files needs no subagent/);
  assert.match(text, /--match-head-commit <sha>/);
  assert.match(decide(start(custom, "startup")).hookSpecificOutput.additionalContext, /at most 5 changed lines in 1 file needs/);
});

test("a swarm.direct section that does not parse names the key and leaves the rest of the note", (t) => {
  const [bad] = checkouts(t, [{ swarm: { dispatch: {}, direct: { maxLines: 0 } } }]);
  const text = decide(start(bad, "startup")).hookSpecificOutput.additionalContext;
  assert.ok(text.startsWith(BASE));
  assert.match(text, /Direct lane is off: swarm\.direct\.maxLines/);
});

test("the direct lane note says when a merge needs a review", (t) => {
  const [none, some, every] = checkouts(t, [
    { swarm: { dispatch: {} } },
    { swarm: { dispatch: {}, direct: { reviewPaths: ["src/**", "api/**"] } } },
    { swarm: { dispatch: {}, direct: { reviewPaths: ["**"] } } },
  ]);
  const noteOf = (dir) => decide(start(dir, "startup")).hookSpecificOutput.additionalContext;
  assert.match(noteOf(none), /--match-head-commit <sha>` and no review\./);
  const partial = noteOf(some);
  assert.match(partial, /--match-head-commit <sha>`\. A merge needs one APPROVED review of the head \(sdd-reviewer\) when a changed path matches swarm\.direct\.reviewPaths\./);
  assert.doesNotMatch(partial, /no review/);
  const all = noteOf(every);
  assert.match(all, /--match-head-commit <sha>`\. Every direct merge needs one APPROVED review of the head \(sdd-reviewer\)\./);
  assert.doesNotMatch(all, /no review/);
});

test("the direct lane note reads the limits at worktree.base, and the checkout's when that read fails", (t) => {
  const [dir] = checkouts(t, [{ swarm: { dispatch: {}, direct: { maxLines: 5, reviewPaths: ["**"] } } }]);
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  for (const [key, value] of [["user.name", "qc"], ["user.email", "qc@example.com"], ["commit.gpgsign", "false"]]) git("config", key, value);
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {}, direct: { maxLines: 500 } } }));
  const noteOf = () => decide(start(dir, "startup")).hookSpecificOutput.additionalContext;
  const text = noteOf();
  assert.match(text, /at most 5 changed lines in 2 files needs no subagent/);
  assert.match(text, /Every direct merge needs one APPROVED review/);
  git("update-ref", "-d", "refs/remotes/origin/main");
  assert.match(noteOf(), /at most 500 changed lines in 2 files needs no subagent/);
});

test("a local swarm.direct of false turns the direct lane note off, whatever the base says", (t) => {
  const [dir] = checkouts(t, [{ swarm: { dispatch: {} } }]);
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  for (const [key, value] of [["user.name", "qc"], ["user.email", "qc@example.com"], ["commit.gpgsign", "false"]]) git("config", key, value);
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {}, direct: false } }));
  assert.doesNotMatch(decide(start(dir, "startup")).hookSpecificOutput.additionalContext, /needs no subagent/);
});

test("the models line names each role's models for the runtime, and how to dispatch it", () => {
  const claude = modelsLine({ models: runtimeModels.claude, runtime: "claude" });
  assert.match(claude, /the claude runtime: sdd-planner opus, sdd-implementer sonnet, sdd-reviewer sonnet, sdd-branch-reviewer opus\./);
  assert.match(claude, /Name that model on each dispatch/);
  const codex = modelsLine({ models: runtimeModels.codex, runtime: "codex" });
  assert.match(codex, /the codex runtime: sdd-planner gpt-6\.1-sol, sdd-implementer gpt-6\.1-sol/);
  assert.match(modelsLine({ models: {}, runtime: null }), /unknown runtime \(set QC_RUNTIME to claude or codex\): sdd-planner the session's model/);
});

test("the controller note says an implementer may run on Codex, and to fall back to a Claude sonnet on exit 2", () => {
  for (const phrase of [
    /qc codex-implement --brief <file> --worktree <path> --progress <file>/,
    /exit 2 \(a Codex limit\)/,
    /architecture:sdd-implementer \(sonnet\)/,
    /same brief/,
  ]) {
    assert.match(CODEX_LINE, phrase);
  }
  assert.ok(!REMINDER.includes("codex-implement"));
});

test("QC_ROLE=implementer replaces the controller note with the worker note", (t) => {
  const [on] = checkouts(t, [{ swarm: { dispatch: {} } }]);
  const text = decide(start(on, "startup"), { QC_ROLE: "implementer" }).hookSpecificOutput.additionalContext;
  assert.equal(text, WORKER_NOTE);
  assert.ok(!text.includes("Run one implementer at a time"));
  assert.ok(!text.includes("sdd-planner"));
});

test("the worker note says to work inline, run one test file, commit each task, and write ALL TASKS DONE", () => {
  for (const phrase of [
    /implementer under a controller/,
    /Work inline/,
    /Never use superpowers:subagent-driven-development, helper agents, task reviews, or fix-review rounds/,
    /failing test, run only that test file, make it pass/,
    /typecheck and lint on what you touched/,
    /commit that task at once/,
    /Do not run the full local gate or e2e; CI runs them/,
    /append `ALL TASKS DONE` to the progress file the brief names/,
    /context gets large.*end the turn.*fresh session continues/,
  ]) {
    assert.match(WORKER_NOTE, phrase);
  }
  assert.ok(WORKER_NOTE.length < 1000, `${WORKER_NOTE.length} characters`);
});

test("another QC_ROLE, or none, keeps the controller note", (t) => {
  const [on] = checkouts(t, [{ swarm: { direct: false, dispatch: {} } }]);
  for (const env of [{}, { QC_ROLE: "" }, { QC_ROLE: "controller" }]) {
    assert.equal(decide(start(on, "startup"), env).hookSpecificOutput.additionalContext, BASE, JSON.stringify(env));
  }
});

test("the worker note keeps the explore line, stays silent with dispatch off, and leaves SubagentStart alone", (t) => {
  const [explore, off] = checkouts(t, [{ swarm: { dispatch: {}, explore: { tools: [{ name: "CocoIndex", use: "u", how: "h" }] } } }, null]);
  const env = { QC_ROLE: "implementer" };
  const text = decide(start(explore, "startup"), env).hookSpecificOutput.additionalContext;
  assert.ok(text.startsWith(WORKER_NOTE));
  assert.match(text, /CocoIndex/);
  assert.equal(decide(start(off, "startup"), env), null);
  assert.equal(decide(subagentStart(explore), env).hookSpecificOutput.hookEventName, "SubagentStart");
});

test("the hook process reads QC_ROLE from its environment", (t) => {
  const [on] = checkouts(t, [{ swarm: { direct: false, dispatch: {} } }]);
  const run = (env) => spawnSync(process.execPath, [NOTE], { input: JSON.stringify(start(on, "startup")), encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(JSON.parse(run({ QC_ROLE: "implementer" }).stdout).hookSpecificOutput.additionalContext, WORKER_NOTE);
  assert.equal(JSON.parse(run({}).stdout).hookSpecificOutput.additionalContext, BASE);
});
