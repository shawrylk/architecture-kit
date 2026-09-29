import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readLedger } from "./ledger.mjs";
import { decide, planPathOf } from "./plan-stop.mjs";

const HOOK = fileURLToPath(new URL("./plan-stop.mjs", import.meta.url));
const PLANNER = fileURLToPath(new URL("../../../../agents/sdd-planner.md", import.meta.url));
const GOOD = [
  "# Plan",
  "",
  "### Task 1: One",
  "",
  "- Create: `a.mjs`",
  "**Estimate:** 20 tool calls",
  "- [ ] **Step 1: Write the failing test**",
  "- [ ] **Step 2: Commit**",
  "",
].join("\n");

function workspace(t) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-plan-stop-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const on = path.join(base, "on");
  const plain = path.join(base, "plain");
  execFileSync("git", ["init", "-q", on], { stdio: "pipe" });
  execFileSync("git", ["init", "-q", plain], { stdio: "pipe" });
  writeFileSync(path.join(on, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {} } }));
  const tmp = path.join(base, "tmp");
  const plans = path.join(base, "plans");
  mkdirSync(tmp);
  mkdirSync(plans);
  writeFileSync(path.join(plans, "good.md"), GOOD);
  writeFileSync(path.join(plans, "big.md"), GOOD.replace("20 tool calls", "50 tool calls"));
  return { on, plain, tmp, plans, ledger: path.join(on, ".git", "qc", "ledger.jsonl") };
}

const handback = (cwd, message, event = "PreToolUse") => ({
  session_id: "s",
  cwd,
  hook_event_name: event,
  tool_name: "SubagentHandback",
  tool_input: { message },
  agent_id: "planner-1",
  agent_type: "architecture:sdd-planner",
});
const stop = (cwd, last, active = false) => ({
  session_id: "s",
  cwd,
  hook_event_name: "SubagentStop",
  agent_id: "planner-1",
  agent_type: "sdd-planner",
  last_assistant_message: last,
  stop_hook_active: active,
});
const denied = (output) => output?.hookSpecificOutput?.permissionDecisionReason ?? null;

test("the plan path is read from its PLAN: line", () => {
  assert.equal(planPathOf("PLAN: C:/plans/a.md\nTask 1: 20 calls"), "C:/plans/a.md");
  assert.equal(planPathOf("The plan is at a.md"), null);
});

test("with swarm.dispatch off, or for another agent type, nothing is judged", (t) => {
  const ws = workspace(t);
  assert.equal(decide(handback(ws.plain, "no plan line"), ws.tmp), null);
  assert.equal(decide({ ...stop(ws.on, "no plan line"), agent_type: "sdd-reviewer" }, ws.tmp), null);
});

test("a planner hand-back with no PLAN: line, an unreadable plan, or a plan that fails the check is refused", (t) => {
  const ws = workspace(t);
  assert.match(denied(decide(handback(ws.on, "Done."), ws.tmp)) ?? "", /PLAN:/);
  assert.match(denied(decide(handback(ws.on, `PLAN: ${path.join(ws.plans, "none.md")}`), ws.tmp)) ?? "", /cannot be read/);
  assert.match(denied(decide(handback(ws.on, `PLAN: ${path.join(ws.plans, "big.md")}`), ws.tmp)) ?? "", /Task 1 estimates 50 tool calls/);
});

test("a kept hand-back with a good plan lets the stop pass, and the stop is recorded with the plan", (t) => {
  const ws = workspace(t);
  const message = `PLAN: ${path.join(ws.plans, "good.md")}\nTask 1: 20 calls`;
  assert.equal(decide(handback(ws.on, message), ws.tmp), null);
  assert.equal(decide(handback(ws.on, message, "PostToolUse"), ws.tmp), null);
  assert.equal(decide(stop(ws.on, "Sent."), ws.tmp), null);
  const [record] = readLedger(ws.ledger);
  assert.deepEqual([record.type, record.role, record.plan], ["stop", "planner", path.join(ws.plans, "good.md")]);
});

test("a planner stop with no hand-back is judged on its last message", (t) => {
  const ws = workspace(t);
  assert.equal(decide(stop(ws.on, "Done."), ws.tmp)?.decision, "block");
  assert.equal(decide(stop(ws.on, `PLAN: ${path.join(ws.plans, "good.md")}`), ws.tmp), null);
});

test("the planner definition asks for the PLAN: line and the estimate line", () => {
  const text = readFileSync(PLANNER, "utf8");
  assert.match(text, /`PLAN: <absolute path of the plan>`/);
  assert.match(text, /`\*\*Estimate:\*\* <n> tool calls`/);
});

test("the hook process is silent in a checkout without the checks", (t) => {
  const ws = workspace(t);
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(stop(ws.plain, "Done.")),
    env: { ...process.env, TEMP: ws.tmp, TMP: ws.tmp, TMPDIR: ws.tmp },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(existsSync(ws.ledger), false);
});

test("a stop that a block already held once ends with a message and records nothing", (t) => {
  const ws = workspace(t);
  assert.equal(decide(stop(ws.on, "Done."), ws.tmp)?.decision, "block");
  const output = decide(stop(ws.on, "Done.", true), ws.tmp);
  assert.equal(output.decision, undefined);
  assert.match(output.systemMessage, /PLAN:/);
  assert.equal(existsSync(ws.ledger), false);
});

test("the retry after a block records the plan once the report is fixed", (t) => {
  const ws = workspace(t);
  assert.equal(decide(stop(ws.on, "Done."), ws.tmp)?.decision, "block");
  assert.equal(decide(stop(ws.on, `PLAN: ${path.join(ws.plans, "good.md")}`, true), ws.tmp), null);
  assert.deepEqual(readLedger(ws.ledger).map((record) => [record.type, record.role]), [["stop", "planner"]]);
});

test("a plan named with a Git Bash drive path resolves on Windows", { skip: process.platform !== "win32" }, (t) => {
  const ws = workspace(t);
  const gitBash = "/" + path.join(ws.plans, "good.md").replace(/^([A-Za-z]):/, (_, drive) => drive.toLowerCase()).replaceAll("\\", "/");
  assert.equal(decide(handback(ws.on, `PLAN: ${gitBash}`), ws.tmp), null);
  assert.equal(decide(stop(ws.on, `PLAN: ${gitBash}`), ws.tmp), null);
  assert.equal(readLedger(ws.ledger)[0].plan.toLowerCase(), path.join(ws.plans, "good.md").toLowerCase());
});
