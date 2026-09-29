import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decide } from "./explore-guard.mjs";
import { slotDirOf } from "./dispatch-slot.mjs";

const TOOLS = [{ name: "slm-rerank", use: "find the files for a concept", how: 'slm-rerank -q "<question>" --stub -k 5' }];
const markerNameOf = (absolute) => `${createHash("sha256").update(absolute).digest("hex")}.refused`;

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

test("a refusal leaves one marker file named by the sha256 of the absolute path, nothing else", (t) => {
  const ws = workspace(t);
  const file = longFile(ws.on);
  assert.notEqual(decide(readCall(ws.on, file), ws.tmp), null);
  const dir = slotDirOf("session-aaaa", ws.tmp);
  assert.deepEqual(readdirSync(dir), [markerNameOf(file)]);
});

test("two refusals of different files each leave their own marker; consuming one leaves the other", (t) => {
  const ws = workspace(t);
  const fileA = longFile(ws.on, "a.txt");
  const fileB = longFile(ws.on, "b.txt");
  assert.notEqual(decide(readCall(ws.on, fileA), ws.tmp), null);
  assert.notEqual(decide(readCall(ws.on, fileB), ws.tmp), null);
  const dir = slotDirOf("session-aaaa", ws.tmp);
  assert.deepEqual(new Set(readdirSync(dir)), new Set([markerNameOf(fileA), markerNameOf(fileB)]));

  assert.equal(decide(readCall(ws.on, fileA), ws.tmp), null);
  assert.deepEqual(readdirSync(dir), [markerNameOf(fileB)]);
});

test("the session state folder holds only marker files, never a shared list file", (t) => {
  const ws = workspace(t);
  const fileA = longFile(ws.on, "a.txt");
  const fileB = longFile(ws.on, "b.txt");
  decide(readCall(ws.on, fileA), ws.tmp);
  decide(readCall(ws.on, fileB), ws.tmp);
  const dir = slotDirOf("session-aaaa", ws.tmp);
  for (const name of readdirSync(dir)) assert.match(name, /^[0-9a-f]{64}\.refused$/);
});

test("a third whole read after a consumed marker is refused again", (t) => {
  const ws = workspace(t);
  const file = longFile(ws.on);
  assert.notEqual(decide(readCall(ws.on, file), ws.tmp), null); // first: refused, marker recorded
  assert.equal(decide(readCall(ws.on, file), ws.tmp), null); // second: passes, marker consumed
  const dir = slotDirOf("session-aaaa", ws.tmp);
  assert.equal(existsSync(path.join(dir, markerNameOf(file))), false);
  assert.notEqual(decide(readCall(ws.on, file), ws.tmp), null); // third: refused again
});

test("a file outside the checkout passes with no judgment", (t) => {
  const ws = workspace(t);
  const outside = mkdtempSync(path.join(os.tmpdir(), "qc-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const file = longFile(outside);
  assert.equal(decide(readCall(ws.on, file), ws.tmp), null);
});

test("a refusal is consumed by a retry through a differently spelled path", (t) => {
  const ws = workspace(t);
  const file = longFile(ws.on);
  assert.notEqual(decide(readCall(ws.on, file), ws.tmp), null);
  const drive = /^[a-zA-Z]:/.test(file) ? file[0] : null;
  const respelled =
    drive !== null
      ? (drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()) + file.slice(1)
      : path.join(ws.on, "..", path.basename(ws.on), path.basename(file));
  assert.equal(decide(readCall(ws.on, respelled), ws.tmp), null);
});

test("a non-Read call, or a Read with no file_path, sees no change", (t) => {
  const ws = workspace(t);
  assert.equal(decide({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {} }, ws.tmp), null);
  assert.equal(decide({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {}, cwd: ws.on }, ws.tmp), null);
});
