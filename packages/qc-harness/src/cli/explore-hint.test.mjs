import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decide } from "./explore-hint.mjs";

const HOOKS = fileURLToPath(new URL("../../../../hooks/hooks.json", import.meta.url));

const TOOLS = [{ name: "slm-rerank", use: "find the files for a concept", how: 'slm-rerank -q "<question>" --stub -k 5' }];

/** A checkout with `swarm.explore` on, and one with no config. */
function workspace(t, explore = { tools: TOOLS, maxGrepLines: 5, maxOutputChars: 20, summarizer: "lfm-ask" }) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-explore-hint-")));
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

const call = (cwd, tool_name, tool_response) => ({
  cwd,
  hook_event_name: "PostToolUse",
  tool_name,
  tool_input: {},
  tool_response,
});

const contextOf = (result) => result?.hookSpecificOutput?.additionalContext ?? null;

const lines = (n) => Array.from({ length: n }, (_, i) => `match ${i}`).join("\n");

test("a Grep answer over maxGrepLines adds context naming the tools", (t) => {
  const ws = workspace(t);
  const text = contextOf(decide(call(ws.on, "Grep", lines(10))));
  assert.match(text, /slm-rerank/);
});

test("a Grep answer at or under maxGrepLines sees no change", (t) => {
  const ws = workspace(t);
  assert.equal(decide(call(ws.on, "Grep", lines(3))), null);
});

test("a command output over maxOutputChars adds context naming the summarizer", (t) => {
  const ws = workspace(t);
  const text = contextOf(decide(call(ws.on, "Bash", "x".repeat(30))));
  assert.match(text, /lfm-ask/);
});

test("PowerShell is judged the same way as Bash", (t) => {
  const ws = workspace(t);
  const text = contextOf(decide(call(ws.on, "PowerShell", "x".repeat(30))));
  assert.match(text, /lfm-ask/);
});

test("a command output at or under maxOutputChars sees no change", (t) => {
  const ws = workspace(t);
  assert.equal(decide(call(ws.on, "Bash", "x".repeat(10))), null);
});

test("no summarizer configured means no output hint even over the limit", (t) => {
  const ws = workspace(t, { tools: TOOLS, maxGrepLines: 5, maxOutputChars: 20, summarizer: null });
  assert.equal(decide(call(ws.on, "Bash", "x".repeat(30))), null);
});

test("a checkout with no swarm.explore section sees no change", (t) => {
  const ws = workspace(t);
  assert.equal(decide(call(ws.plain, "Grep", lines(10))), null);
  assert.equal(decide(call(ws.plain, "Bash", "x".repeat(30))), null);
});

test("a non-Grep, non-Bash, non-PowerShell tool, or a non-PostToolUse call, sees no change", (t) => {
  const ws = workspace(t);
  assert.equal(decide(call(ws.on, "Read", "x".repeat(30))), null);
  assert.equal(decide({ ...call(ws.on, "Grep", lines(10)), hook_event_name: "PreToolUse" }), null);
});

test("a bad key reports the error as context instead of a hint", (t) => {
  const ws = workspace(t, { maxGrepLines: "many" });
  const text = contextOf(decide(call(ws.on, "Grep", lines(10))));
  assert.match(text, /swarm\.explore\.maxGrepLines/);
});

test("hooks.json runs the hint on PostToolUse Grep and Bash|PowerShell", () => {
  const { hooks } = JSON.parse(readFileSync(HOOKS, "utf8"));
  const matchers = (hooks.PostToolUse ?? [])
    .filter((entry) => entry.hooks.some((hook) => hook.command.includes("explore-hint.mjs")))
    .map((entry) => entry.matcher);
  assert.deepEqual(matchers.sort(), ["Bash|PowerShell", "Grep"]);
});
