import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { GLOBAL_SKILLS } from "../global-skills.mjs";

const core = readFileSync(new URL("../../../../user-config/claude/CLAUDE.core.md", import.meta.url), "utf8");

test("the core template excludes personal instructions and paths", () => {
  for (const text of ["Grammar", "Global Claude Rules", "~/.claude", ".Codex"]) {
    assert.ok(!core.includes(text), `The core template contains ${text}`);
  }
});

test("the core template starts with the skills heading", () => {
  assert.ok(core.startsWith("## Rules that live in skills"));
});

test("the core template excludes setup markers", () => {
  assert.doesNotMatch(core, /^.*architecture-kit:(?:begin|end).*$/m);
});

for (const name of GLOBAL_SKILLS) {
  test(`the core template qualifies every reference to ${name}`, () => {
    assert.ok(core.includes(`architecture:${name}`));
    assert.doesNotMatch(core, new RegExp("(?<!architecture:)\\b" + name + "\\b"));
  });
}
