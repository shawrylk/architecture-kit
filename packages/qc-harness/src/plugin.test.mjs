import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PLUGIN = fileURLToPath(new URL("../../../", import.meta.url));
const EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

test("every skill applies only where qc.config.json exists, in its description and in its body", () => {
  const skills = readdirSync(`${PLUGIN}skills`);
  assert.ok(skills.length > 0);
  for (const skill of skills) {
    const text = readFileSync(`${PLUGIN}skills/${skill}/SKILL.md`, "utf8");
    const description = /^description: (.+)$/m.exec(text)?.[1] ?? "";
    assert.match(description, /only in a repository with a `qc\.config\.json`/, skill);
    assert.match(text, /This skill applies only to a repository with a `qc\.config\.json` at its root/, skill);
  }
});

test("each guard that keeps an edit inside its paths runs on every edit tool", () => {
  const { hooks } = JSON.parse(readFileSync(`${PLUGIN}hooks/hooks.json`, "utf8"));
  for (const guard of ["pre-edit-guard.sh", "controller-guard.mjs", "slot-guard.mjs"]) {
    const entry = hooks.PreToolUse.find((group) => group.hooks.some((hook) => hook.command.includes(guard)));
    assert.ok(entry, guard);
    const tools = entry.matcher.split("|");
    for (const tool of EDIT_TOOLS) assert.ok(tools.includes(tool), `${guard} misses ${tool}`);
  }
});
