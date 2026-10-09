import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HOOKS = fileURLToPath(new URL("../../../../hooks/hooks.json", import.meta.url));
const HOOKS_DIR = path.dirname(HOOKS);
const CLI = fileURLToPath(new URL(".", import.meta.url));
const { hooks } = JSON.parse(readFileSync(HOOKS, "utf8"));

const matchersOf = (event, script) =>
  (hooks[event] ?? []).filter((entry) => entry.hooks.some((hook) => hook.command.includes(`/${script}"`))).map((entry) => entry.matcher);

test("hooks.json runs each workflow check on its events", () => {
  assert.deepEqual(matchersOf("PreToolUse", "controller-guard.mjs"), ["Write|Edit|MultiEdit|NotebookEdit"]);
  for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) {
    assert.deepEqual(matchersOf(event, "merge-guard.mjs"), ["Bash|PowerShell"], event);
  }
  for (const script of ["report-stop.mjs", "plan-stop.mjs"]) {
    assert.deepEqual(matchersOf("PreToolUse", script), ["SubagentHandback"], script);
    assert.deepEqual(matchersOf("PostToolUse", script), ["SubagentHandback"], script);
    assert.deepEqual(matchersOf("SubagentStop", script), [undefined], script);
  }
  assert.deepEqual(matchersOf("Stop", "issue-gate.mjs"), [undefined]);
  assert.deepEqual(matchersOf("Stop", "worktree-gate.mjs"), [undefined]);
});

test("every node script hooks.json names exists", () => {
  const scripts = Object.values(hooks)
    .flat()
    .flatMap((entry) => entry.hooks.map((hook) => /src\/cli\/([a-z-]+\.mjs)/.exec(hook.command)?.[1]))
    .filter(Boolean);
  for (const script of new Set(scripts)) assert.ok(existsSync(path.join(CLI, script)), script);
});

test("every hook script in src/cli is registered, in hooks.json or in a shell hook it serves", () => {
  const registered = JSON.stringify(hooks);
  const shellHooks = readdirSync(HOOKS_DIR)
    .filter((file) => file.endsWith(".sh"))
    .map((file) => readFileSync(path.join(HOOKS_DIR, file), "utf8"))
    .join("\n");
  const entries = readdirSync(CLI).filter((file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs"))
    .filter((file) => /\bisEntryPoint\b/.test(readFileSync(path.join(CLI, file), "utf8")));
  assert.ok(entries.length >= 15, `found only ${entries.length} hook entries`);
  const unregistered = entries.filter((file) => !registered.includes(`/${file}\\"`) && !shellHooks.includes(file));
  assert.deepEqual(unregistered, [], "each hook entry point must be registered, or it never runs");
});

test("each workflow script is silent in a checkout without swarm.dispatch", (t) => {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-workflow-hooks-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: base, stdio: "pipe" });
  writeFileSync(path.join(base, "qc.config.json"), JSON.stringify({ swarm: {} }));
  const events = {
    "controller-guard.mjs": { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(base, "src", "a.ts") } },
    "merge-guard.mjs": { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "gh pr merge 1" } },
    "report-stop.mjs": { hook_event_name: "SubagentStop", agent_id: "a", agent_type: "sdd-reviewer", last_assistant_message: "x" },
    "plan-stop.mjs": { hook_event_name: "SubagentStop", agent_id: "a", agent_type: "sdd-planner", last_assistant_message: "x" },
    "issue-gate.mjs": { hook_event_name: "Stop" },
  };
  for (const [script, event] of Object.entries(events)) {
    const result = spawnSync(process.execPath, [path.join(CLI, script)], {
      input: JSON.stringify({ session_id: "s", cwd: base, ...event }),
      env: { ...process.env, TEMP: base, TMP: base, TMPDIR: base },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    assert.equal(result.stdout, "", script);
  }
});

test("hooks.json runs the skill guard on the Skill tool, and gives the dispatch guard time for its git and gh reads", () => {
  assert.deepEqual(matchersOf("PreToolUse", "skill-guard.mjs"), ["Skill"]);
  const entry = hooks.PreToolUse.find((candidate) => candidate.hooks.some((hook) => hook.command.includes("/dispatch-guard.mjs\"")));
  assert.equal(entry.matcher, "Agent");
  assert.equal(entry.hooks.find((hook) => hook.command.includes("/dispatch-guard.mjs\"")).timeout, 30);
});

test("the skill guard is silent without swarm.dispatch, and denies a code-review skill with it", (t) => {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-skill-hooks-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: base, stdio: "pipe" });
  const run = (config) => {
    writeFileSync(path.join(base, "qc.config.json"), JSON.stringify(config));
    const event = { session_id: "s", cwd: base, hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: "code-review" } };
    return spawnSync(process.execPath, [path.join(CLI, "skill-guard.mjs")], { input: JSON.stringify(event), encoding: "utf8" });
  };
  assert.equal(run({ swarm: {} }).stdout, "");
  assert.equal(JSON.parse(run({ swarm: { dispatch: {} } }).stdout).hookSpecificOutput.permissionDecision, "deny");
});
