import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decide, excerptOf, replacedOutput } from "./explore-hint.mjs";

const HOOKS = fileURLToPath(new URL("../../../../hooks/hooks.json", import.meta.url));

const TOOLS = [{ name: "slm-rerank", use: "find the files for a concept", how: 'slm-rerank -q "<question>" --stub -k 5' }];

/** A checkout with `swarm.explore` on, and one with no config. */
function workspace(t, explore = { tools: TOOLS, maxGrepLines: 5, maxOutputChars: 20, longOutput: "hint", summarizer: "lfm-ask" }) {
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
  const ws = workspace(t, { tools: TOOLS, maxGrepLines: 5, maxOutputChars: 20, longOutput: "hint", summarizer: null });
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

test("a Grep { content } shaped answer over maxGrepLines adds context naming the tools", (t) => {
  const ws = workspace(t);
  const text = contextOf(decide(call(ws.on, "Grep", { content: lines(10) })));
  assert.match(text, /slm-rerank/);
});

test("a Grep { matches } shaped answer over maxGrepLines adds context naming the tools", (t) => {
  const ws = workspace(t);
  const matches = Array.from({ length: 10 }, (_, i) => `match ${i}`);
  const text = contextOf(decide(call(ws.on, "Grep", { matches })));
  assert.match(text, /slm-rerank/);
});

test("a Grep answer of unknown shape counts real newlines and escaped \\n sequences", (t) => {
  const ws = workspace(t);
  const text = contextOf(decide(call(ws.on, "Grep", { blob: lines(10) })));
  assert.match(text, /slm-rerank/);
});

test("a Bash { stdout, stderr } shaped answer over maxOutputChars adds context naming the summarizer", (t) => {
  const ws = workspace(t);
  const text = contextOf(decide(call(ws.on, "Bash", { stdout: "x".repeat(15), stderr: "y".repeat(15) })));
  assert.match(text, /lfm-ask/);
});

test("a Bash answer of unknown shape over maxOutputChars adds context naming the summarizer", (t) => {
  const ws = workspace(t);
  const text = contextOf(decide(call(ws.on, "Bash", { info: "x".repeat(30) })));
  assert.match(text, /lfm-ask/);
});

test("a null tool_response sees no change", (t) => {
  const ws = workspace(t);
  assert.equal(decide(call(ws.on, "Grep", null)), null);
  assert.equal(decide(call(ws.on, "Bash", null)), null);
});

test("hooks.json runs the hint on PostToolUse Grep and Bash|PowerShell", () => {
  const { hooks } = JSON.parse(readFileSync(HOOKS, "utf8"));
  const matchers = (hooks.PostToolUse ?? [])
    .filter((entry) => entry.hooks.some((hook) => hook.command.includes("explore-hint.mjs")))
    .map((entry) => entry.matcher);
  assert.deepEqual(matchers.sort(), ["Bash|PowerShell", "Grep"]);
});

const bashResponse = (stdout) => ({ stdout, stderr: "", interrupted: false, isImage: false });
const longOutput = `${"h".repeat(50)}\n${"m".repeat(1000)}\nnot ok 3 - breaks\n${"m".repeat(2000)}\n${"t".repeat(80)}`;
const excerptWorkspace = (t, extra = {}) =>
  workspace(t, { tools: TOOLS, maxOutputChars: 120, summarizer: '<command> | lfm-ask "<question>"', excerptChars: 100, ...extra });

test("a long successful output is saved whole and reaches Claude as its head, its failure lines, and its tail", (t) => {
  const ws = excerptWorkspace(t);
  const scratch = path.join(ws.on, "scratch");
  const output = decide({ ...call(ws.on, "Bash", bashResponse(longOutput)), tool_use_id: "toolu_9", scratchpad_dir: scratch });
  const replaced = output.hookSpecificOutput.updatedToolOutput;
  const file = path.join(scratch, "outputs", "toolu_9.txt");
  assert.equal(readFileSync(file, "utf8"), longOutput);
  assert.equal(replaced.stderr, "");
  assert.equal(replaced.isImage, false);
  assert.ok(replaced.stdout.startsWith("h".repeat(25)));
  assert.ok(replaced.stdout.endsWith("t".repeat(75)));
  assert.match(replaced.stdout, /not ok 3 - breaks/);
  assert.ok(replaced.stdout.includes(file));
  assert.ok(replaced.stdout.includes(`cat "${file}" | lfm-ask`));
  assert.ok(replaced.stdout.length < longOutput.length);
});

test("with no scratchpad folder, the whole output goes under the temp folder of the session", (t) => {
  const ws = excerptWorkspace(t);
  const tmp = path.join(ws.on, "tmp");
  const output = decide({ ...call(ws.on, "Bash", bashResponse(longOutput)), session_id: "s/1", tool_use_id: "toolu_1" }, tmp);
  assert.ok(output.hookSpecificOutput.updatedToolOutput.stdout.includes(path.join(tmp, "architecture-kit", "outputs", "s_1", "toolu_1.txt")));
  assert.ok(existsSync(path.join(tmp, "architecture-kit", "outputs", "s_1", "toolu_1.txt")));
});

test("one long line with no failure is still cut, and a string output stays a string", (t) => {
  const ws = excerptWorkspace(t);
  const scratch = path.join(ws.on, "scratch");
  const oneLine = "x".repeat(5000);
  const output = decide({ ...call(ws.on, "PowerShell", oneLine), tool_use_id: "toolu_2", scratchpad_dir: scratch });
  const replaced = output.hookSpecificOutput.updatedToolOutput;
  assert.equal(typeof replaced, "string");
  assert.ok(replaced.length < 1000);
  assert.doesNotMatch(replaced, /name a failure/);
});

test("longOutput hint, an image, an unknown shape, or an output under twice excerptChars keeps the hint", (t) => {
  const hint = excerptWorkspace(t, { longOutput: "hint" });
  assert.match(contextOf(decide(call(hint.on, "Bash", bashResponse(longOutput)))) ?? "", /lfm-ask/);
  const ws = excerptWorkspace(t);
  assert.match(contextOf(decide(call(ws.on, "Bash", { ...bashResponse(longOutput), isImage: true }))) ?? "", /lfm-ask/);
  assert.match(contextOf(decide(call(ws.on, "Bash", { lines: longOutput.split("\n") }))) ?? "", /lfm-ask/);
  assert.match(contextOf(decide(call(ws.on, "Bash", bashResponse("y".repeat(150))))) ?? "", /lfm-ask/);
});

test("a wrong longOutput or excerptChars is a named config error, reported as context", (t) => {
  for (const extra of [{ longOutput: "cut" }, { excerptChars: 0 }]) {
    const ws = excerptWorkspace(t, extra);
    assert.match(contextOf(decide(call(ws.on, "Bash", bashResponse(longOutput)))) ?? "", /Explore guard is off: swarm\.explore\./);
  }
});

test("an excerptChars that is not smaller than maxOutputChars is a named config error, reported as context", (t) => {
  for (const excerptChars of [120, 5000]) {
    const ws = excerptWorkspace(t, { excerptChars });
    assert.match(contextOf(decide(call(ws.on, "Bash", bashResponse(longOutput)))) ?? "", /Explore guard is off: swarm\.explore\.excerptChars .*smaller than maxOutputChars \(120\)/);
  }
  const fine = excerptWorkspace(t, { excerptChars: 119 });
  assert.ok(decide(call(fine.on, "Bash", bashResponse(longOutput))).hookSpecificOutput.updatedToolOutput);
});

test("excerptOf keeps a quarter for the head, the rest for the tail, and at most 20 failure lines", () => {
  const text = `${"a".repeat(100)}\n${Array.from({ length: 30 }, (_, index) => `error ${index}`).join("\n")}\n${"z".repeat(400)}`;
  const { head, signal, tail, omitted } = excerptOf(text, 200);
  assert.equal(head.length, 50);
  assert.equal(tail.length, 150);
  assert.equal(signal.length, 20);
  assert.equal(omitted, text.length - 200);
  assert.equal(replacedOutput({ output: "x" }, "y").output, "y");
  assert.equal(replacedOutput(null, "y"), null);
});

test("replacedOutput blanks a non-empty stderr and keeps the other fields", () => {
  const replaced = replacedOutput({ stdout: "out", stderr: "boom", interrupted: false, isImage: false }, "y");
  assert.deepEqual(replaced, { stdout: "y", stderr: "", interrupted: false, isImage: false });
});

test("an excerpt with no summarizer names the file and offers no summarizer", (t) => {
  const ws = excerptWorkspace(t, { summarizer: null });
  const scratch = path.join(ws.on, "scratch");
  const output = decide({ ...call(ws.on, "Bash", bashResponse(longOutput)), tool_use_id: "toolu_3", scratchpad_dir: scratch });
  const { stdout } = output.hookSpecificOutput.updatedToolOutput;
  assert.ok(stdout.includes(path.join(scratch, "outputs", "toolu_3.txt")));
  assert.doesNotMatch(stdout, /Ask the summarizer/);
});

test("a save that fails leaves the output whole and shows the hint", (t) => {
  const ws = excerptWorkspace(t);
  const blocker = path.join(ws.on, "blocker");
  writeFileSync(blocker, "a regular file");
  const output = decide({ ...call(ws.on, "Bash", bashResponse(longOutput)), tool_use_id: "toolu_4" }, path.join(blocker, "tmp"));
  assert.equal(output.hookSpecificOutput.updatedToolOutput, undefined);
  assert.match(contextOf(output) ?? "", /lfm-ask/);
});
