import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decide } from "./explore-guard.mjs";

const TOOLS = [{ name: "CocoIndex", use: "find the files for a concept", how: 'ccc search "<question>"' }];

/** Temporary checkouts isolate the read hint from the repository configuration. */
function workspace(t, explore = { tools: TOOLS, maxReadLines: 5 }) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-explore-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const on = path.join(base, "on");
  const plain = path.join(base, "plain");
  for (const dir of [on, plain]) {
    mkdirSync(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" });
  }
  writeFileSync(path.join(on, "qc.config.json"), JSON.stringify({ swarm: { explore } }));
  return { on, plain };
}

const readCall = (cwd, file_path, extra = {}) => ({
  session_id: "session-aaaa",
  cwd,
  hook_event_name: "PreToolUse",
  tool_name: "Read",
  tool_input: { file_path, ...extra },
});

const longFile = (dir, name = "long.txt", lines = 20) => {
  const file = path.join(dir, name);
  writeFileSync(file, Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n") + "\n");
  return file;
};

test("a whole-file read receives optional advice and proceeds on the first attempt", (t) => {
  const ws = workspace(t);
  const file = longFile(ws.on);
  const output = decide(readCall(ws.on, file)).hookSpecificOutput;
  assert.equal(output.hookEventName, "PreToolUse");
  assert.equal(output.permissionDecision, undefined);
  assert.match(output.additionalContext, /optional/i);
  assert.match(output.additionalContext, /CocoIndex/);
});

test("repeated whole-file reads proceed without a retry", (t) => {
  const ws = workspace(t);
  const file = longFile(ws.on);
  for (let i = 0; i < 3; i += 1) {
    const output = decide(readCall(ws.on, file)).hookSpecificOutput;
    assert.equal(output.permissionDecision, undefined);
    assert.ok(output.additionalContext);
  }
});

test("a long read with no configured tools receives range advice and proceeds", (t) => {
  const ws = workspace(t, { maxReadLines: 5 });
  const output = decide(readCall(ws.on, longFile(ws.on))).hookSpecificOutput;
  assert.equal(output.permissionDecision, undefined);
  assert.match(output.additionalContext, /offset and limit/);
});

test("a ranged read passes even on the first attempt", (t) => {
  const ws = workspace(t);
  const file = longFile(ws.on);
  assert.equal(decide(readCall(ws.on, file, { offset: 1, limit: 5 })), null);
});

test("an exempt path passes", (t) => {
  const ws = workspace(t, { tools: TOOLS, maxReadLines: 5, exempt: ["**/long.txt"] });
  const file = longFile(ws.on);
  assert.equal(decide(readCall(ws.on, file)), null);
});

test("a file within the line budget passes", (t) => {
  const ws = workspace(t);
  const file = longFile(ws.on, "short.txt", 3);
  assert.equal(decide(readCall(ws.on, file)), null);
});

test("a binary file by extension passes with no line count", (t) => {
  const ws = workspace(t);
  const file = path.join(ws.on, "image.png");
  writeFileSync(file, Buffer.from(Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join(""), "utf8"));
  assert.equal(decide(readCall(ws.on, file)), null);
});

test("a binary file by a NUL byte passes even with an unlisted extension", (t) => {
  const ws = workspace(t);
  const file = path.join(ws.on, "data.bin");
  const body = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join("");
  writeFileSync(file, Buffer.concat([Buffer.from(body, "utf8"), Buffer.from([0])]));
  assert.equal(decide(readCall(ws.on, file)), null);
});

test("a checkout with no swarm.explore section sees no change", (t) => {
  const ws = workspace(t);
  const file = longFile(ws.plain);
  assert.equal(decide(readCall(ws.plain, file)), null);
});

test("a bad key reports the error as context instead of refusing", (t) => {
  const ws = workspace(t, { maxReadLines: "many" });
  const file = longFile(ws.on);
  const result = decide(readCall(ws.on, file));
  assert.match(result.hookSpecificOutput.additionalContext, /swarm\.explore\.maxReadLines/);
});

test("a file outside the checkout passes with no judgment", (t) => {
  const ws = workspace(t);
  const outside = mkdtempSync(path.join(os.tmpdir(), "qc-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const file = longFile(outside);
  assert.equal(decide(readCall(ws.on, file)), null);
});

test("a file in a different checkout passes even though the session's own checkout turns the guard on", (t) => {
  const ws = workspace(t);
  const file = longFile(ws.plain);
  assert.equal(decide(readCall(ws.on, file)), null);
});

test("a non-Read call, or a Read with no file_path, sees no change", (t) => {
  const ws = workspace(t);
  assert.equal(decide({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {} }), null);
  assert.equal(decide({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {}, cwd: ws.on }), null);
});
