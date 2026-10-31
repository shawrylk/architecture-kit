import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ARM_NOTE, decide } from "./watch-arm.mjs";

const NOTE = fileURLToPath(new URL("./watch-arm.mjs", import.meta.url));
const HOOKS = fileURLToPath(new URL("../../../../hooks/hooks.json", import.meta.url));

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

test("a checkout without dispatch gets no watch note", (t) => {
  const [plain, off] = checkouts(t, [null, { swarm: { toolCallBudget: 50 } }]);
  assert.equal(decide(start(plain, "startup"), {}), null);
  assert.equal(decide(start(off, "startup"), {}), null);
});

test("dispatch adds the watch note on every session start source", (t) => {
  const [on] = checkouts(t, [{ swarm: { dispatch: {} } }]);
  for (const source of ["startup", "resume", "clear", "compact"]) {
    assert.deepEqual(decide(start(on, source), {}), {
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ARM_NOTE },
    }, source);
  }
});

test("an implementer gets no watch note", (t) => {
  const [on] = checkouts(t, [{ swarm: { dispatch: {} } }]);
  assert.equal(decide(start(on, "startup"), { QC_ROLE: "implementer" }), null);
});

test("a dispatch config error leaves the note silent", (t) => {
  const [bad] = checkouts(t, [{ swarm: { dispatch: { maxPromptChars: "long" } } }]);
  assert.equal(decide(start(bad, "startup"), {}), null);
});

test("the short note names each watch and the hourly check", () => {
  for (const phrase of ["qc watch --pr <n>", "--codex <wrapper.log>", "--run <workflow>@<branch>", "hourly"]) {
    assert.ok(ARM_NOTE.includes(phrase), phrase);
  }
  assert.ok(ARM_NOTE.length < 700, `${ARM_NOTE.length} characters`);
});

test("the hook prints JSON for an orchestrator and stays silent elsewhere", (t) => {
  const [on, plain] = checkouts(t, [{ swarm: { dispatch: {} } }, null]);
  const run = (cwd, role) => spawnSync(process.execPath, [NOTE], {
    input: JSON.stringify(start(cwd, "startup")),
    encoding: "utf8",
    env: { ...process.env, QC_ROLE: role },
  });
  const noted = run(on, "");
  assert.equal(noted.status, 0, noted.stderr);
  assert.deepEqual(JSON.parse(noted.stdout), {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ARM_NOTE },
  });
  for (const silent of [run(plain, ""), run(on, "implementer")]) {
    assert.equal(silent.status, 0, silent.stderr);
    assert.equal(silent.stdout, "");
  }
});

test("hooks.json arms the watch on SessionStart without a matcher", () => {
  const { hooks } = JSON.parse(readFileSync(HOOKS, "utf8"));
  const entries = (hooks.SessionStart ?? []).filter((entry) =>
    entry.hooks.some((hook) => hook.command.includes("watch-arm.mjs")),
  );
  assert.deepEqual(entries.map((entry) => entry.matcher), [undefined]);
  const hook = entries[0].hooks.find((item) => item.command.includes("watch-arm.mjs"));
  assert.equal(hook.type, "command");
  assert.equal(hook.command, 'node "${CLAUDE_PLUGIN_ROOT}/packages/qc-harness/src/cli/watch-arm.mjs"');
  assert.equal(hook.timeout, 10);
});
