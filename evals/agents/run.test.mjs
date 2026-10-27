import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { skillActivationOf } from "./run.mjs";

test("skill activation requires an assistant Skill call naming the exact expected skill", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-skill-eval-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, "run.jsonl");
  const expected = "architecture:writing-plain-english";
  const event = (name, skill, type = "assistant") => ({ type, message: {
    content: [{ type: "tool_use", name, input: { skill } }],
  } });
  assert.equal(skillActivationOf(transcript, expected), false);
  for (const record of [event("Read", expected), event("Skill", "other"), event("Skill", expected, "user"),
    event("Skill", `${expected}-extra`), { type: "assistant", message: { content: expected } }]) {
    writeFileSync(transcript, `broken\n${JSON.stringify(record)}\n`);
    assert.equal(skillActivationOf(transcript, expected), false);
  }
  writeFileSync(transcript, `broken\n${JSON.stringify(event("Skill", expected))}\n`);
  assert.equal(skillActivationOf(transcript, expected), true);
});
