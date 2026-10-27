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

test("open questions need their own Source with a file line or URL before hand-back and stop", (t) => {
  const ws = workspace(t);
  const file = path.join(ws.plans, "questions.md");
  const message = `PLAN: ${file}`;
  for (const question of [
    "- Which store? Recommend SQLite.",
    "- Which store? Source: storage.mjs. Recommend SQLite.",
    "- Which store? Source: storage.mjs:0. Recommend SQLite.",
    "- Which store? Source: https://. Recommend SQLite.",
    "- Which store? Source: storage.mjs:12. Recommend SQLite.\n- Which region? Recommend EU.",
    "Which store?\nSource: storage.mjs:12. Recommend SQLite.\n\nWhich region?",
  ]) {
    writeFileSync(file, `${GOOD}\n## Open questions\n${question}\n`);
    assert.match(denied(decide(handback(ws.on, message), ws.tmp)) ?? "", /Source:/);
    assert.match(decide(stop(ws.on, message), ws.tmp)?.reason ?? "", /Source:/);
    assert.equal(existsSync(ws.ledger), false);
  }
  for (const question of [
    "- Which store? Recommend SQLite. Source: `storage.mjs:12`.",
    "1. Which store? Recommend SQLite. **Source:** https://example.com/storage",
    "- Which store?\n  Recommend SQLite.\n  Source: C:/repo/storage.mjs:12",
    "- None.",
  ]) {
    writeFileSync(file, `${GOOD}\n## Open questions\n${question}\n## Product decisions\n- Use SQLite.\n`);
    assert.equal(decide(handback(ws.on, message), ws.tmp), null, question);
  }
});

test("question refusals quote six words and reject times and step numbers as sources", (t) => {
  const ws = workspace(t);
  const file = path.join(ws.plans, "questions.md");
  for (const source of ["the user at 10:30", "step:2"]) {
    writeFileSync(file, `${GOOD}\n## Open questions\n- Which storage engine should this service use? Source: ${source}\n`);
    const reason = denied(decide(handback(ws.on, `PLAN: ${file}`), ws.tmp));
    assert.match(reason ?? "", /"Which storage engine should this service"/);
    assert.match(reason ?? "", /Source:/);
  }
});

test("open question introductions pass while bare questions still need a source", (t) => {
  const ws = workspace(t);
  const file = path.join(ws.plans, "questions.md");
  const intro = "The spec leaves two questions open.";
  writeFileSync(file, `${GOOD}\n## Open questions\n${intro}\n- Which store? Source: storage.mjs:12\n`);
  assert.equal(decide(handback(ws.on, `PLAN: ${file}`), ws.tmp), null);
  writeFileSync(file, `${GOOD}\n## Open questions\n${intro}\nWhich region should the storage service use?\n`);
  assert.match(denied(decide(handback(ws.on, `PLAN: ${file}`), ws.tmp)) ?? "", /"Which region should the storage service"/);
});

test("the hook caps five plan and question problems at three", (t) => {
  const ws = workspace(t);
  const file = path.join(ws.plans, "many.md");
  const bad = GOOD.replace("a.mjs", "schemas/api.json").replace("- [ ] **Step 2: Commit**", "");
  writeFileSync(file, `${bad}\n${bad.replace("Task 1:", "Task 2:")}\n## Open questions\n- Which store?\n`);
  const message = `PLAN: ${file}`;
  for (const reason of [denied(decide(handback(ws.on, message), ws.tmp)), decide(stop(ws.on, message), ws.tmp)?.reason]) {
    assert.deepEqual(reason.match(/\d\)/g), ["1)", "2)", "3)"]);
    assert.match(reason, /Task 1 missing \*\*Risk:\*\*/);
    assert.match(reason, /Task 2 missing \*\*Risk:\*\*/);
  }
});

test("the planner definition asks for the PLAN: line and the estimate line", () => {
  const text = readFileSync(PLANNER, "utf8");
  assert.match(text, /`PLAN: <absolute path of the plan>`/);
  assert.match(text, /`\*\*Estimate:\*\* <n> tool calls`/);
  assert.match(text, /swarm\.review\.riskPaths/);
  assert.match(text, /swarm\.review\.cases/);
});

test("the planner hook forwards configured risk paths and acceptance cases", (t) => {
  const ws = workspace(t);
  const review = { riskPaths: ["*.mjs"], cases: { "*.mjs": ["loading", "error"] } };
  writeFileSync(path.join(ws.on, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {}, review } }));
  const file = path.join(ws.plans, "good.md");
  const message = `PLAN: ${file}`;
  const reason = denied(decide(handback(ws.on, message), ws.tmp));
  assert.match(reason ?? "", /Task 1 missing \*\*Risk:\*\*/);
  assert.match(reason ?? "", /Task 1 missing cases.*loading, error/);
  assert.equal(decide(stop(ws.on, message), ws.tmp)?.decision, "block");
  writeFileSync(file, GOOD.replace("**Estimate:**", "**Risk:** Writes fail; errors appear; revert the change.\n**Estimate:**").replace("failing test", "loading and error test"));
  assert.equal(decide(handback(ws.on, message), ws.tmp), null);
  writeFileSync(path.join(ws.on, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {}, review: { riskPaths: [] } } }));
  writeFileSync(file, GOOD.replace("a.mjs", "schemas/api.json"));
  assert.equal(decide(handback(ws.on, message), ws.tmp), null);
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
