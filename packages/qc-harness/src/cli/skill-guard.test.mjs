import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decide, isListedSkill } from "./skill-guard.mjs";

function checkout(t, config) {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-skill-guard-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" });
  if (config !== null) writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify(config));
  return dir;
}

const call = (cwd, skill, extra = {}) => ({
  session_id: "s",
  cwd,
  hook_event_name: "PreToolUse",
  tool_name: "Skill",
  tool_input: { skill, args: "max" },
  ...extra,
});
const reasonOf = (result) => result?.hookSpecificOutput?.permissionDecisionReason ?? "";

test("a skill is listed by its name or by the part after the colon", () => {
  const list = ["code-review"];
  assert.equal(isListedSkill("code-review", list), true);
  assert.equal(isListedSkill("Code-Review", list), true);
  assert.equal(isListedSkill(" /code-review ", list), true);
  assert.equal(isListedSkill("code-review:code-review", list), true);
  assert.equal(isListedSkill("any-plugin:code-review", list), true);
  assert.equal(isListedSkill("code-reviewer", list), false);
  assert.equal(isListedSkill("superpowers:requesting-code-review", list), false);
  assert.equal(isListedSkill("a:b", ["a:b"]), true);
  assert.equal(isListedSkill("code-review", []), false);
  assert.equal(isListedSkill(undefined, list), false);
});

test("with swarm.dispatch on, the guard refuses a code-review skill and names the way out", (t) => {
  const dir = checkout(t, { swarm: { dispatch: {} } });
  for (const skill of ["code-review", "code-review:code-review", "x:code-review"]) {
    const result = decide(call(dir, skill));
    assert.equal(result.hookSpecificOutput.permissionDecision, "deny", skill);
    assert.match(reasonOf(result), /sdd-branch-reviewer/);
    assert.match(reasonOf(result), /\/code-review/);
  }
});

test("a skill outside the list passes, and so does every other tool", (t) => {
  const dir = checkout(t, { swarm: { dispatch: {} } });
  assert.equal(decide(call(dir, "superpowers:brainstorming")), null);
  assert.equal(decide(call(dir, "code-reviewer")), null);
  assert.equal(decide({ ...call(dir, "code-review"), tool_name: "Read" }), null);
  assert.equal(decide({ ...call(dir, "code-review"), tool_input: {} }), null);
  assert.equal(decide({ ...call(dir, "code-review"), hook_event_name: "PostToolUse" }), null);
});

test("swarm.review.codeReviewSkills replaces the list, and [] turns the check off", (t) => {
  const custom = checkout(t, { swarm: { dispatch: {}, review: { codeReviewSkills: ["my-review"] } } });
  assert.equal(decide(call(custom, "code-review")), null);
  assert.equal(decide(call(custom, "p:my-review")).hookSpecificOutput.permissionDecision, "deny");
  const off = checkout(t, { swarm: { dispatch: {}, review: { codeReviewSkills: [] } } });
  assert.equal(decide(call(off, "code-review")), null);
});

test("the guard is silent where swarm.dispatch is off, or where there is no config", (t) => {
  assert.equal(decide(call(checkout(t, null), "code-review")), null);
  assert.equal(decide(call(checkout(t, { swarm: {} }), "code-review")), null);
});

test("a wrong swarm.review value lets the call through with a note", (t) => {
  const dir = checkout(t, { swarm: { dispatch: {}, review: { codeReviewSkills: "code-review" } } });
  const result = decide(call(dir, "code-review"));
  assert.equal(result.hookSpecificOutput.permissionDecision, undefined);
  assert.match(result.hookSpecificOutput.additionalContext, /Skill guard is off: .*codeReviewSkills/);
});

test("the script reads the hook payload from stdin and writes the refusal", (t) => {
  const dir = checkout(t, { swarm: { dispatch: {} } });
  const script = fileURLToPath(new URL("./skill-guard.mjs", import.meta.url));
  const run = (skill) => spawnSync(process.execPath, [script], { input: JSON.stringify(call(dir, skill)), encoding: "utf8" });
  assert.equal(JSON.parse(run("code-review").stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(run("brainstorming").stdout, "");
});
