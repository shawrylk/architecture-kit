import { strict as assert } from "node:assert";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkHandoffFile, handoffPathOf, handoffProblems, parseHandoff, resolveHandoff } from "./handoff-note.mjs";

const NOTE = [
  "# Hand-off: Task 3",
  "Brief: C:/scratch/briefs/task-3.md",
  "Worktree: C:/work/kit-85",
  "Branch: feat/85-context",
  "Head: 1a2b3c4",
  "",
  "## Done",
  "- 1a2b3c4 the reader",
  "",
  "## Left",
  "1. wire the guard",
  "",
  "## Next step",
  "node --test packages/qc-harness/src/cli/budget-guard.test.mjs",
].join("\n");

test("a complete note parses and has no problem", () => {
  const note = parseHandoff(NOTE);
  assert.equal(note.head, "1a2b3c4");
  assert.equal(note.branch, "feat/85-context");
  assert.deepEqual(note.left, ["1. wire the guard"]);
  assert.deepEqual(handoffProblems(NOTE), []);
  assert.deepEqual(handoffProblems(NOTE.replaceAll("\n", "\r\n")), []);
});

test("each missing line and each empty section is named", () => {
  const problems = handoffProblems(NOTE.replace("Head: 1a2b3c4\n", "").replace("1. wire the guard\n", ""));
  assert.ok(problems.includes("a line `Head: <value>`"), problems.join("; "));
  assert.ok(problems.includes("a `## Left` section with at least one line"), problems.join("; "));
  assert.match(handoffProblems(NOTE.replace("Head: 1a2b3c4", "Head: tbd")).join("; "), /Head:` sha of 7 to 40 hex digits/);
});

test("the HANDOFF line is read from a report or a prompt, with or without quotes", () => {
  assert.equal(handoffPathOf("DONE_WITH_CONCERNS\nHANDOFF: C:/scratch/handoffs/t3-1.md\n"), "C:/scratch/handoffs/t3-1.md");
  assert.equal(handoffPathOf('HANDOFF: "/tmp/handoffs/a b.md"'), "/tmp/handoffs/a b.md");
  assert.equal(handoffPathOf("no line"), null);
  assert.equal(resolveHandoff("notes/a.md", path.resolve("/base")), path.resolve("/base", "notes/a.md"));
});

test("the marker is spelled HANDOFF, in capitals", () => {
  assert.equal(handoffPathOf("Handoff: none"), null);
  assert.equal(handoffPathOf("handoff: C:/scratch/handoffs/t3-1.md"), null);
});

test("a HANDOFF word inside a line is not the HANDOFF line", () => {
  assert.equal(handoffPathOf("see the HANDOFF: C:/scratch/handoffs/t3-1.md above"), null);
  assert.equal(handoffPathOf("see the HANDOFF: C:/scratch/handoffs/t3-1.md above\nHANDOFF: C:/scratch/handoffs/real.md"), "C:/scratch/handoffs/real.md");
});

test("a field name inside a line is not that field, and the field line further down still counts", () => {
  assert.equal(parseHandoff("the Head: 1a2b3c4 was tbd").head, null);
  assert.equal(parseHandoff("the Head: deadbeef was tbd\nHead: 1a2b3c4").head, "1a2b3c4");
});

test("checkHandoffFile reads the note, and a missing file is one problem", (t) => {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-handoff-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const file = path.join(base, "note.md");
  writeFileSync(file, NOTE);
  assert.deepEqual(checkHandoffFile(file, base), { file, missing: null, problems: [] });
  const gone = checkHandoffFile(path.join(base, "gone.md"), base);
  assert.equal(gone.missing, "ENOENT");
});
