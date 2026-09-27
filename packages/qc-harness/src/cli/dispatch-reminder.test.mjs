import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REMINDER, decide } from "./dispatch-reminder.mjs";

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

test("a checkout with no config, or no dispatch section, gets no note", (t) => {
  const [plain, off] = checkouts(t, [null, { swarm: { toolCallBudget: 50 } }]);
  assert.equal(decide(start(plain, "startup")), null);
  assert.equal(decide(start(off, "startup")), null);
});

test("with the section on, every start adds the note, a compaction included", (t) => {
  const [on] = checkouts(t, [{ swarm: { dispatch: {} } }]);
  for (const source of ["startup", "resume", "clear", "compact"]) {
    const output = decide(start(on, source));
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart", source);
    assert.equal(output.hookSpecificOutput.additionalContext, REMINDER, source);
  }
});

test("the note names the workflow, the three types, and the one-implementer rule, in a short text", () => {
  for (const word of [
    "superpowers:subagent-driven-development",
    "architecture:sdd-planner",
    "architecture:sdd-implementer",
    "architecture:sdd-reviewer",
    "one implementer at a time",
  ]) {
    assert.ok(REMINDER.includes(word), word);
  }
  assert.ok(REMINDER.length < 600, `${REMINDER.length} characters`);
});

test("a config error reaches the session as context", (t) => {
  const [bad] = checkouts(t, [{ swarm: { dispatch: { maxPromptChars: "long" } } }]);
  assert.match(decide(start(bad, "startup")).hookSpecificOutput.additionalContext, /Dispatch guard is off/);
});

test("hooks.json runs the note on every SessionStart source", () => {
  const { hooks } = JSON.parse(readFileSync(HOOKS, "utf8"));
  const entries = (hooks.SessionStart ?? []).filter((entry) =>
    entry.hooks.some((hook) => hook.command.includes("dispatch-reminder.mjs")),
  );
  assert.deepEqual(entries.map((entry) => entry.matcher), [undefined]);
});
