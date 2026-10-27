import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkpointPathOf, checkpointProblem, decide, readCheckpoint } from "./checkpoint.mjs";

const text = "## Goal\nKeep my tasks\n## Rules\nKeep constraints\n## Tasks\n- Open: build\n## Next\nBuild it\n";
function workspace(t) {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-checkpoint-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  const file = checkpointPathOf(root, "session-1");
  mkdirSync(path.dirname(file), { recursive: true });
  return { root, file };
}

test("checkpoint path belongs to the common Git directory and contains the session safely", (t) => {
  const { root, file } = workspace(t);
  assert.equal(file, path.join(root, ".git", "qc", "checkpoints", "session-1.md"));
  assert.equal(path.dirname(checkpointPathOf(root, "../../escape")), path.dirname(file));
  const linked = path.join(root, "linked");
  execFileSync("git", ["-c", "user.name=qc", "-c", "user.email=qc@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "init"], { cwd: root });
  execFileSync("git", ["worktree", "add", "-qb", "linked", linked], { cwd: root });
  assert.equal(checkpointPathOf(linked, "session-1"), file);
  assert.notEqual(checkpointPathOf(root, "session-2"), file);
});

test("shape requires exact headings and at most 60 nonblank lines", () => {
  assert.equal(checkpointProblem(text), null);
  for (const heading of ["Goal", "Rules", "Tasks", "Next"]) {
    assert.match(checkpointProblem(text.replace(`## ${heading}`, `### ${heading}`)), /heading/);
  }
  assert.equal(checkpointProblem(text + "\n".repeat(90)), null);
  assert.equal(checkpointProblem(text + "task\n".repeat(52)), null);
  assert.match(checkpointProblem(text + "task\n".repeat(53)), /60/);
});

test("reader reports missing files, invalid shape, and age from modification time", (t) => {
  const { file } = workspace(t);
  assert.match(readCheckpoint(file).problem, /missing/);
  writeFileSync(file, "## Goal\n");
  assert.match(readCheckpoint(file).problem, /heading/);
  writeFileSync(file, text);
  const now = Date.now();
  utimesSync(file, new Date(now - 31 * 60_000), new Date(now - 31 * 60_000));
  assert.match(readCheckpoint(file, { now }).problem, /older/);
  assert.equal(readCheckpoint(file, { now, maxAgeMinutes: 0 }).problem, null);
  assert.equal(readCheckpoint(file, { now, maxAgeMinutes: 32 }).text, text);
  assert.match(readCheckpoint(path.dirname(file)).problem, /read/);
});

test("SessionStart names the absolute checkpoint path even with dispatch off", (t) => {
  const { root, file } = workspace(t);
  writeFileSync(path.join(root, "qc.config.json"), "{}");
  const call = { cwd: root, session_id: "session-1", hook_event_name: "SessionStart", source: "startup" };
  const output = decide(call).hookSpecificOutput;
  assert.equal(output.hookEventName, "SessionStart");
  assert.ok(output.additionalContext.includes(file));
  for (const heading of ["## Goal", "## Rules", "## Tasks", "## Next"]) assert.ok(output.additionalContext.includes(heading));
  assert.match(output.additionalContext, /write/i);
  assert.match(output.additionalContext, /60 non-blank lines/);
  assert.equal(decide({ ...call, agent_id: "worker" }), null);
  assert.equal(decide({ ...call, hook_event_name: "PreToolUse" }), null);
  assert.equal(decide({ ...call, cwd: os.tmpdir() }), null);
});

test("compact and resume restore the checkpoint as the source of truth", (t) => {
  const { root, file } = workspace(t);
  writeFileSync(path.join(root, "qc.config.json"), "{}");
  writeFileSync(file, text);
  const call = { cwd: root, session_id: "session-1", hook_event_name: "SessionStart" };
  for (const source of ["compact", "resume"]) {
    const output = decide({ ...call, source }).hookSpecificOutput.additionalContext;
    assert.ok(output.includes(file));
    assert.match(output, /source of truth for open work/);
    assert.ok(output.includes(text.trim()));
  }
  assert.ok(!decide({ ...call, source: "startup" }).hookSpecificOutput.additionalContext.includes("Keep my tasks"));
});

test("restoration caps lines and characters and reports read errors without blocking", (t) => {
  const { root, file } = workspace(t);
  writeFileSync(path.join(root, "qc.config.json"), "{}");
  const call = { cwd: root, session_id: "session-1", hook_event_name: "SessionStart", source: "compact" };
  writeFileSync(file, Array.from({ length: 90 }, (_, n) => `line-${n}`).join("\n"));
  let note = decide(call).hookSpecificOutput.additionalContext;
  assert.ok(note.split(/\r?\n/).length <= 60);
  assert.match(note, /line-57/);
  assert.doesNotMatch(note, /line-58/);
  assert.match(note, /60 lines.*4,000 characters/);
  writeFileSync(file, "x".repeat(9000));
  note = decide(call).hookSpecificOutput.additionalContext;
  assert.ok(note.length <= 4000);
  assert.match(note, /60 lines.*4,000 characters/);
  rmSync(file);
  mkdirSync(file);
  note = decide(call).hookSpecificOutput.additionalContext;
  assert.match(note, /cannot read/);
  assert.ok(note.includes(file));
  assert.equal(decide(call).hookSpecificOutput.permissionDecision, undefined);
});

test("checkpoint has exactly one SessionStart hook", () => {
  const hooks = JSON.parse(readFileSync(new URL("../../../../hooks/hooks.json", import.meta.url), "utf8"));
  const entries = hooks.hooks.SessionStart.flatMap((entry) => entry.hooks).filter((hook) => hook.command.includes("/checkpoint.mjs"));
  assert.equal(entries.length, 1);
  assert.match(hooks.description, /checkpoint/i);
});

test("both orchestrator skills use the session checkpoint and its fixed headings", () => {
  for (const skill of ["codex", "swarm"]) {
    const source = readFileSync(new URL(`../../../../skills/${skill}/SKILL.md`, import.meta.url), "utf8");
    assert.ok(source.includes("<git common dir>/qc/checkpoints/<session_id>.md"), skill);
    for (const heading of ["## Goal", "## Rules", "## Tasks", "## Next"]) assert.ok(source.includes(heading), `${skill}: ${heading}`);
    assert.doesNotMatch(source, /`checkpoint\.md` in the scratchpad/);
    assert.match(source, /60 non-blank lines/);
  }
});

test("the reference and Codex skill document the prompt rule caps and filters", () => {
  for (const file of ["docs/reference.md", "skills/codex/SKILL.md"]) {
    const source = readFileSync(new URL(`../../../../${file}`, import.meta.url), "utf8");
    assert.match(source, /20 `Rule:` lines/);
    assert.match(source, /2,000 characters/);
    assert.match(source, /duplicates after trimming/);
    assert.match(source, /starts with `none:`/);
  }
  const reference = readFileSync(new URL("../../../../docs/reference.md", import.meta.url), "utf8");
  assert.match(reference, /60 non-blank lines/);
  assert.match(reference, /60 lines.*4,000 characters/);
});
