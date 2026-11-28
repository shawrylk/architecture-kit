import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("skills/codex/SKILL.md has at most 100 non-blank lines", () => {
  const lines = readFileSync(new URL("../../../../skills/codex/SKILL.md", import.meta.url), "utf8").split(/\r?\n/).filter((line) => line.trim());
  assert.ok(lines.length <= 100, `codex skill has ${lines.length} non-blank lines`);
});
test("skills/codex/SKILL.md stays at or under 4721 bytes and names the plan commands", () => {
  const text = readFileSync(new URL("../../../../skills/codex/SKILL.md", import.meta.url), "utf8");
  assert.ok(Buffer.byteLength(text) <= 4721, `${Buffer.byteLength(text)} bytes`);
  for (const command of ["qc plan new", "qc plan status", "qc plan revalidate"]) assert.ok(text.includes(command), command);
});
