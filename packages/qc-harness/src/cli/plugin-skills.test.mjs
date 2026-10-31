import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SKILLS = fileURLToPath(new URL("../../../../skills/", import.meta.url));
const FIELDS = new Set([
  "name", "description", "argument-hint", "disable-model-invocation", "user-invocable",
  "allowed-tools", "model", "context", "agent", "hooks",
]);

for (const folder of readdirSync(SKILLS, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
  test(`${folder.name} has bounded skill metadata with a use clause and known fields`, () => {
    const text = readFileSync(path.join(SKILLS, folder.name, "SKILL.md"), "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    assert.ok(match, "skill has frontmatter");
    const fields = Object.fromEntries([...match[1].matchAll(/^([\w-]+):\s*(.*)$/gm)]
      .map(([, key, value]) => [key, value.trim().replace(/^(["'])(.*)\1$/, "$2")]));
    assert.equal(fields.name, folder.name);
    assert.ok(fields.description?.length <= 600, "description has at most 600 characters");
    assert.match(fields.description, /\bUse (?:when|only)\b/);
    for (const key of Object.keys(fields)) assert.ok(FIELDS.has(key), `unknown field: ${key}`);
  });
}
