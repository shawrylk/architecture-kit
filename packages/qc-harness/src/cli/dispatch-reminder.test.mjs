import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REMINDER, decide } from "./dispatch-reminder.mjs";

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
    assert.equal(output.hookSpecificOutput.additionalContext, REMINDER, source);
  }
});

test("the note names the workflow, the four types, the model tiers, and the one-implementer rule, in a short text", () => {
  for (const word of [
    "superpowers:subagent-driven-development",
    "architecture:sdd-planner",
    "architecture:sdd-implementer",
    "architecture:sdd-reviewer",
    "architecture:sdd-branch-reviewer",
    "one implementer at a time",
    "gpt-6.1-sol",
    "high reasoning effort",
    "Worktree: <path>",
    "VERDICT: <APPROVED|CHANGES_REQUIRED> <sha>",
    "--match-head-commit <sha>",
  ]) {
    assert.ok(REMINDER.includes(word), word);
  }
  assert.ok(REMINDER.length < 800, `${REMINDER.length} characters`);
});

test("with swarm.explore also on, the note names its tools", (t) => {
  const [on] = checkouts(t, [
    { swarm: { dispatch: {}, explore: { tools: [{ name: "CocoIndex", use: "u", how: "h" }, { name: "GitNexus", use: "u", how: "h" }] } } },
  ]);
  const text = decide(start(on, "startup")).hookSpecificOutput.additionalContext;
  assert.ok(text.startsWith(REMINDER));
  assert.match(text, /CocoIndex, GitNexus/);
  assert.match(text, /optional/i);
});

test("with swarm.explore off, or naming no tools, the note is exactly REMINDER", (t) => {
  const [off, empty] = checkouts(t, [
    { swarm: { direct: false, dispatch: {} } },
    { swarm: { direct: false, dispatch: {}, explore: { tools: [] } } },
  ]);
  assert.equal(decide(start(off, "startup")).hookSpecificOutput.additionalContext, REMINDER);
  assert.equal(decide(start(empty, "startup")).hookSpecificOutput.additionalContext, REMINDER);
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
  assert.equal(JSON.parse(noted.stdout).hookSpecificOutput.additionalContext, REMINDER);
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

test("a limit above 1 adds one line stating it, and a limit of 1 leaves the note as REMINDER", (t) => {
  const [three, one] = checkouts(t, [
    { swarm: { dispatch: { implementerSlots: 3 } } },
    { swarm: { direct: false, dispatch: { implementerSlots: 1 } } },
  ]);
  const text = decide(start(three, "startup")).hookSpecificOutput.additionalContext;
  assert.ok(text.startsWith(REMINDER));
  assert.match(text, /up to 3 implementers at once/);
  assert.equal(decide(start(one, "startup")).hookSpecificOutput.additionalContext, REMINDER);
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

test("a swarm.explore section that does not parse leaves SubagentStart silent and the session note as REMINDER", (t) => {
  const [bad] = checkouts(t, [{ swarm: { direct: false, dispatch: {}, explore: { tools: "CocoIndex" } } }]);
  assert.equal(decide(subagentStart(bad)), null);
  assert.equal(decide(start(bad, "startup")).hookSpecificOutput.additionalContext, REMINDER);
});

test("with the direct lane on by default, the note names its limits after REMINDER", (t) => {
  const [lane, custom] = checkouts(t, [{ swarm: { dispatch: {} } }, { swarm: { dispatch: {}, direct: { maxLines: 5, maxFiles: 1 } } }]);
  const text = decide(start(lane, "startup")).hookSpecificOutput.additionalContext;
  assert.ok(text.startsWith(REMINDER));
  assert.match(text, /at most 20 changed lines in 2 files needs no subagent/);
  assert.match(text, /--match-head-commit <sha>/);
  assert.match(decide(start(custom, "startup")).hookSpecificOutput.additionalContext, /at most 5 changed lines in 1 file needs/);
});

test("a swarm.direct section that does not parse names the key and leaves the rest of the note", (t) => {
  const [bad] = checkouts(t, [{ swarm: { dispatch: {}, direct: { maxLines: 0 } } }]);
  const text = decide(start(bad, "startup")).hookSpecificOutput.additionalContext;
  assert.ok(text.startsWith(REMINDER));
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
