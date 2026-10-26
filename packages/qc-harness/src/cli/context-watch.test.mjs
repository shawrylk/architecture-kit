import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decide, START, STEP, TELL_USER } from "./context-watch.mjs";

function fixture(t, sessionId = "s") {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "context-watch-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const transcript = path.join(tmp, "transcript.jsonl");
  mkdirSync(path.join(tmp, ".git"));
  const call = { cwd: tmp, session_id: sessionId, transcript_path: transcript, hook_event_name: "PostToolUse" };
  let request = 0;
  return {
    tmp,
    call,
    state: path.join(tmp, "claude-context-watch", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`),
    at(tokens, overrides = {}) {
      request += 1;
      appendFileSync(transcript, `${JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T00:00:00Z",
        message: {
          id: `m${request}`,
          model: "m",
          usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens - 1 },
        },
      })}\n`);
      return decide({ ...call, ...overrides }, { tmp });
    },
  };
}

test("dispatch owns compaction even with invalid budgets", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.tmp, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {} }, budgets: false }));
  assert.equal(f.at(400_000), null);
  assert.equal(fs.existsSync(f.state), false);
});

test("without dispatch the watch starts at the configured orchestrator budget", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.tmp, "qc.config.json"), JSON.stringify({ budgets: { orchestrator: { compactAt: 400_000 } } }));
  const nested = path.join(f.tmp, "nested");
  mkdirSync(nested);
  assert.equal(f.at(399_999, { cwd: nested }), null);
  assert.match(f.at(400_000, { cwd: nested }).hookSpecificOutput.additionalContext, /400K/);
  assert.equal(f.at(449_999, { cwd: nested }), null);
  assert.match(f.at(450_000, { cwd: nested }).hookSpecificOutput.additionalContext, /450K/);
});

test("a disabled orchestrator budget keeps the watch silent", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.tmp, "qc.config.json"), JSON.stringify({ budgets: { orchestrator: null } }));
  assert.equal(f.at(400_000), null);
  assert.equal(fs.existsSync(f.state), false);
});

test("state changes use an atomic replacement", (t) => {
  const f = fixture(t);
  f.at(400_000);
  f.at(100_000);
  const originalWrite = fs.writeFileSync;
  let writes = 0;
  t.mock.method(fs, "writeFileSync", (file, ...args) => {
    if (path.dirname(String(file)) === path.dirname(f.state)) {
      assert.notEqual(file, f.state);
      writes += 1;
      assert.doesNotThrow(() => JSON.parse(readFileSync(f.state, "utf8")));
    }
    return originalWrite(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.ok(f.at(400_000));
  assert.equal(writes, 1);
  assert.equal(JSON.parse(readFileSync(f.state, "utf8")).step >= 0, true);
  assert.deepEqual(readdirSync(path.dirname(f.state)), [path.basename(f.state)]);
});

test("overlapping hooks note the same threshold once", (t) => {
  const f = fixture(t);
  f.at(400_000);
  f.at(100_000);
  const originalRead = fs.readFileSync;
  let nested;
  let entered = false;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    const data = originalRead(file, ...args);
    if (file === f.state && !entered) {
      entered = true;
      nested = f.at(400_000);
    }
    return data;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.ok(f.at(400_000));
  assert.equal(entered, true);
  assert.equal(nested, null);
});

test("a lock older than 30 seconds expires and the next call takes it", (t) => {
  const f = fixture(t);
  const lock = `${f.state}.lock`;
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 31_000);
  utimesSync(lock, old, old);
  assert.ok(f.at(210_000));
  assert.deepEqual(JSON.parse(readFileSync(f.state, "utf8")), { step: 0 });
  assert.equal(fs.existsSync(lock), false);
  assert.equal(f.at(210_000), null);
});

test("a lock released before stat stays silent", (t) => {
  const f = fixture(t);
  const lock = `${f.state}.lock`;
  mkdirSync(lock, { recursive: true });
  const originalStat = fs.statSync;
  t.mock.method(fs, "statSync", (file, ...args) => {
    if (file === lock) {
      fs.rmdirSync(lock);
      throw Object.assign(new Error("released"), { code: "ENOENT" });
    }
    return originalStat(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(f.at(210_000), null);
  assert.equal(fs.existsSync(f.state), false);
});

test("stale lock removal preserves another hook's replacement lock", (t) => {
  const f = fixture(t);
  const lock = `${f.state}.lock`;
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 31_000);
  utimesSync(lock, old, old);
  const originalRemove = fs.rmdirSync;
  let removed;
  t.mock.method(fs, "rmdirSync", (file, ...args) => {
    assert.notEqual(file, lock);
    assert.ok(String(file).startsWith(`${lock}.`));
    removed = file;
    mkdirSync(lock);
    return originalRemove(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(f.at(210_000), null);
  assert.ok(removed);
  assert.equal(fs.existsSync(removed), false);
  assert.equal(fs.existsSync(lock), true);
  assert.equal(fs.existsSync(f.state), false);
});

test("a competing stale lock claim stays silent", (t) => {
  const f = fixture(t);
  const lock = `${f.state}.lock`;
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 31_000);
  utimesSync(lock, old, old);
  const originalRename = fs.renameSync;
  let claimed = false;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (from === lock) {
      claimed = true;
      fs.rmdirSync(lock);
      throw Object.assign(new Error("claimed"), { code: "ENOENT" });
    }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(f.at(210_000), null);
  assert.equal(claimed, true);
  assert.equal(fs.existsSync(f.state), false);
});

test("a lock at most 30 seconds old stays held", (t) => {
  const f = fixture(t);
  const lock = `${f.state}.lock`;
  mkdirSync(lock, { recursive: true });
  const modified = statSync(lock).mtimeMs;
  t.mock.method(Date, "now", () => modified + 30_000);
  assert.equal(f.at(210_000), null);
  assert.equal(fs.existsSync(lock), true);
  assert.equal(fs.existsSync(f.state), false);
});

for (const operation of ["mkdirSync", "rmdirSync"]) {
  test(`the entry point reports a ${operation} lock error and exits zero without a reminder`, (t) => {
    const f = fixture(t);
    f.at(210_000);
    rmSync(f.state);
    const preload = `import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const original = fs.${operation};
      fs.${operation} = (file, ...args) => {
        if (String(file).endsWith(".lock")) throw new Error("lock failed\\nsecond line");
        return original(file, ...args);
      };
      syncBuiltinESMExports();`;
    const result = spawnSync(process.execPath, [
      "--import", `data:text/javascript,${encodeURIComponent(preload)}`,
      fileURLToPath(new URL("./context-watch.mjs", import.meta.url)),
    ], {
      input: JSON.stringify(f.call), encoding: "utf8",
      env: { ...process.env, TMPDIR: f.tmp, TMP: f.tmp, TEMP: f.tmp },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^context-watch: lock failed second line\r?\n$/);
  });
}

test("a lower step above compactAt preserves the threshold already noted", (t) => {
  const f = fixture(t);
  assert.ok(f.at(400_000));
  assert.equal(f.at(350_000), null);
  assert.equal(f.at(400_000), null);
});

test("keeps the context budgets", () => {
  assert.equal(START, 200_000);
  assert.equal(STEP, 50_000);
  assert.equal(TELL_USER, 300_000);
});

test("speaks once per rising step and resets after compaction", (t) => {
  const f = fixture(t);
  assert.equal(f.at(199_999), null);
  const first = f.at(210_000);
  assert.deepEqual(first, {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext:
        "Context is about 210K tokens. At the next clean break (a task, review, or merge just finished, nothing mid-fix), update the resume notes and ask the user to run /compact before you continue.",
    },
  });
  assert.equal(f.at(210_000), null);
  assert.match(f.at(250_001).hookSpecificOutput.additionalContext, /250K.*\/compact/);
  assert.equal(f.at(300_000).systemMessage, "Context 300K tokens: Claude will ask you to /compact at the next clean break.");
  assert.equal(f.at(100_000), null);
  assert.equal(JSON.parse(readFileSync(f.state, "utf8")).step, -1);
  assert.match(f.at(210_000).hookSpecificOutput.additionalContext, /210K.*\/compact/);
});

test("uses the call's event name and speaks at the exact start", (t) => {
  const f = fixture(t);
  const result = f.at(200_000, { hook_event_name: "UserPromptSubmit" });
  assert.equal(result.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(result.hookSpecificOutput.additionalContext, /200K/);
  assert.equal(Object.hasOwn(result, "systemMessage"), false);
});

test("keeps subagent calls silent without changing the main session's step", (t) => {
  const f = fixture(t);
  assert.equal(f.at(300_000, { agent_id: "a1" }), null);
  assert.match(f.at(210_000, { agent_id: "" }).hookSpecificOutput.additionalContext, /210K/);
});

test("stays silent without a transcript or usage", (t) => {
  const f = fixture(t);
  assert.equal(decide({ session_id: "s" }, { tmp: f.tmp }), null);
  assert.equal(decide(f.call, { tmp: f.tmp }), null);
  writeFileSync(f.call.transcript_path, `${JSON.stringify({ type: "user", message: { content: "hello" } })}\n`);
  assert.equal(decide(f.call, { tmp: f.tmp }), null);
});

test("sanitizes the session id and writes only when the step changes", (t) => {
  const f = fixture(t, "s/../a.b:1_-Z");
  f.at(210_000);
  assert.deepEqual(JSON.parse(readFileSync(f.state, "utf8")), { step: 0 });
  utimesSync(f.state, 1, 1);
  const before = statSync(f.state).mtimeMs;
  assert.equal(f.at(249_999), null);
  assert.equal(statSync(f.state).mtimeMs, before);
  assert.equal(f.at(199_999), null);
  assert.deepEqual(JSON.parse(readFileSync(f.state, "utf8")), { step: -1 });
});

test("registers the context watch for prompts and all tool calls", () => {
  const { hooks } = JSON.parse(readFileSync(new URL("../../../../hooks/hooks.json", import.meta.url), "utf8"));
  const command = 'node "${CLAUDE_PLUGIN_ROOT}/packages/qc-harness/src/cli/context-watch.mjs"';
  for (const event of ["UserPromptSubmit", "PostToolUse"]) {
    const group = hooks[event]?.find((entry) => entry.hooks.some((hook) => hook.command === command));
    assert.ok(group, `${event} has a context watch group`);
    assert.deepEqual(group.hooks, [{ type: "command", command, timeout: 10 }]);
    if (event === "PostToolUse") assert.equal(group.matcher, "*");
    else assert.equal(Object.hasOwn(group, "matcher"), false);
  }
});
