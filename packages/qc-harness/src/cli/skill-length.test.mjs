import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("skills/codex/SKILL.md has at most 100 non-blank lines", () => {
  const lines = readFileSync(new URL("../../../../skills/codex/SKILL.md", import.meta.url), "utf8").split(/\r?\n/).filter((line) => line.trim());
  assert.ok(lines.length <= 100, `codex skill has ${lines.length} non-blank lines`);
});
