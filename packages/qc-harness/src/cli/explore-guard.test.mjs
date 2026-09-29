import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decide } from "./explore-guard.mjs";

const TOOLS = [{ name: "slm-rerank", use: "find the files for a concept", how: 'slm-rerank -q "<question>" --stub -k 5' }];

/** A checkout with `swarm.explore` on, one with no config, and a temp folder for the guard's own state. */
function workspace(t, explore = { tools: TOOLS, maxReadLines: 5 }) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-explore-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const on = path.join(base, "on");
  const plain = path.join(base, "plain");
  const tmp = path.join(base, "tmp");
  for (const dir of [on, plain]) {
    mkdirSync(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" });
  }
  writeFileSync(path.join(on, "qc.config.json"), JSON.stringify({ swarm: { explore } }));
  return { on, plain, tmp };
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

const reasonOf = (result) =>
  result?.hookSpecificOutput?.permissionDecision === "deny" ? result.hookSpecificOutput.permissionDecisionReason : null;

test("a whole-file read of a long text file is refused, naming the tool and the retry", (t) => {
  const ws = workspace(t);
  const file = longFile(ws.on);
  const reason = reasonOf(decide(readCall(ws.on, file), ws.tmp));
  assert.match(reason, /slm-rerank: find the files for a concept \(slm-rerank -q/);
  assert.match(reason, /Read a range with offset and limit, or read the same file again to read it whole\./);
});

test("the same file read the same way passes on the second attempt", (t) => {
  const ws = workspace(t);
  const file = longFile(ws.on);
  assert.notEqual(decide(readCall(ws.on, file), ws.tmp), null);
  assert.equal(decide(readCall(ws.on, file), ws.tmp), null);
});

test("a ranged read passes even on the first attempt", (t) => {
  const ws = workspace(t);
  const file = longFile(ws.on);
  assert.equal(decide(readCall(ws.on, file, { offset: 1, limit: 5 }), ws.tmp), null);
});

test("an exempt path passes", (t) => {
  const ws = workspace(t, { tools: TOOLS, maxReadLines: 5, exempt: ["**/long.txt"] });
  const file = longFile(ws.on);
  assert.equal(decide(readCall(ws.on, file), ws.tmp), null);
});

test("a file within the line budget passes", (t) => {
  const ws = workspace(t);
  const file = longFile(ws.on, "short.txt", 3);
  assert.equal(decide(readCall(ws.on, file), ws.tmp), null);
});

test("a binary file by extension passes with no line count", (t) => {
  const ws = workspace(t);
  const file = path.join(ws.on, "image.png");
  writeFileSync(file, Buffer.from(Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join(""), "utf8"));
  assert.equal(decide(readCall(ws.on, file), ws.tmp), null);
});

test("a binary file by a NUL byte passes even with an unlisted extension", (t) => {
  const ws = workspace(t);
  const file = path.join(ws.on, "data.bin");
  const body = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join("");
  writeFileSync(file, Buffer.concat([Buffer.from(body, "utf8"), Buffer.from([0])]));
  assert.equal(decide(readCall(ws.on, file), ws.tmp), null);
});

test("a checkout with no swarm.explore section sees no change", (t) => {
  const ws = workspace(t);
  const file = longFile(ws.plain);
  assert.equal(decide(readCall(ws.plain, file), ws.tmp), null);
});

test("a bad key reports the error as context instead of refusing", (t) => {
  const ws = workspace(t, { maxReadLines: "many" });
  const file = longFile(ws.on);
  const result = decide(readCall(ws.on, file), ws.tmp);
  assert.match(result.hookSpecificOutput.additionalContext, /swarm\.explore\.maxReadLines/);
});

test("a non-Read call, or a Read with no file_path, sees no change", (t) => {
  const ws = workspace(t);
  assert.equal(decide({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {} }, ws.tmp), null);
  assert.equal(decide({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {}, cwd: ws.on }, ws.tmp), null);
});
