import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { GLOBAL_SKILLS } from "../global-skills.mjs";

const core = readFileSync(new URL("../../../../plugins/architecture-extras/CLAUDE.md", import.meta.url), "utf8");

test("the extras template requires review before merge", () => {
  assert.doesNotMatch(core, /suspend/i);
  assert.ok(core.includes("**Review before merge.** Every pull request gets a review before it merges. `architecture-extras:reviewing-before-merge` has the details."));
});

test("the review skill supplies a route when the guard denies code-review", () => {
  const skill = readFileSync(new URL("../../../../plugins/architecture-extras/skills/reviewing-before-merge/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /guard.*denies.*`\/code-review`.*`architecture:sdd-branch-reviewer`.*user.*`\/code-review`/);
});

test("the extras template excludes personal instructions and paths", () => {
  for (const text of ["Grammar", "Global Claude Rules", "~/.claude", ".Codex"]) {
    assert.ok(!core.includes(text), `The extras template contains ${text}`);
  }
});

test("the extras template starts with the skills heading", () => {
  assert.ok(core.startsWith("## Rules that live in skills"));
});

test("the extras template excludes setup markers", () => {
  assert.doesNotMatch(core, /^.*architecture-kit:(?:begin|end).*$/m);
});

for (const name of GLOBAL_SKILLS) {
  test(`the extras template qualifies every reference to ${name}`, () => {
    assert.ok(core.includes(`architecture-extras:${name}`));
    assert.doesNotMatch(core, new RegExp("(?<!architecture-extras:)\\b" + name + "\\b"));
  });
}
