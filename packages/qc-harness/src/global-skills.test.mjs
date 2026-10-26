import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GLOBAL_SKILLS } from "./global-skills.mjs";

const PLUGIN = fileURLToPath(new URL("../../../", import.meta.url));

test("each global skill has its folder name and a Use when description in its frontmatter", () => {
  for (const skill of GLOBAL_SKILLS) {
    const text = readFileSync(`${PLUGIN}skills/${skill}/SKILL.md`, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] ?? "";
    assert.equal(/^name: (.+)$/m.exec(frontmatter)?.[1], skill, skill);
    assert.match(frontmatter, /^description: "Use when/m, skill);
  }
});

test("global skill files contain no paths tied to a user's machine", () => {
  for (const skill of GLOBAL_SKILLS) {
    const folder = `${PLUGIN}skills/${skill}`;
    for (const entry of readdirSync(folder, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      assert.doesNotMatch(readFileSync(path, "utf8"), /C:\\|\/Users\/|\/home\/|~\//, path);
    }
  }
});

test("the plugin contains exactly the global skills and the kit skills", () => {
  assert.deepEqual(readdirSync(`${PLUGIN}skills`).sort(), [
    ...GLOBAL_SKILLS,
    "ai-chat-assistant",
    "architecture",
    "codex",
    "enforcement",
    "security",
    "swarm",
  ].sort());
});
