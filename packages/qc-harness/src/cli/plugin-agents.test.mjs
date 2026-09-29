import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dispatchDefaults } from "../config.mjs";
import { familyOf } from "./dispatch.mjs";
import { REMINDER } from "./dispatch-reminder.mjs";

const AGENTS = fileURLToPath(new URL("../../../../agents/", import.meta.url));
const PLUGIN = "architecture";
const READ_ONLY_TOOLS = ["Agent", "Write", "Edit", "MultiEdit", "NotebookEdit"];
const EXPECTED = {
  "sdd-implementer": { model: "sonnet", effort: "high", disallowedTools: ["Agent"] },
  "sdd-planner": { model: "opus", effort: "high", disallowedTools: ["Agent"] },
  "sdd-reviewer": { model: "sonnet", effort: "high", disallowedTools: READ_ONLY_TOOLS },
  "sdd-branch-reviewer": { model: "opus", effort: "high", disallowedTools: READ_ONLY_TOOLS },
};

/** The `key: value` lines between the two `---` fences. A checkout on Windows can carry CRLF. */
function frontmatterOf(file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, "utf8"));
  assert.ok(match, `${file} has no frontmatter`);
  return Object.fromEntries(
    match[1].split(/\r?\n/).map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    }),
  );
}

test("each subagent type runs on its model tier at its effort, and none can dispatch a subagent", () => {
  assert.deepEqual(
    readdirSync(AGENTS).sort(),
    Object.keys(EXPECTED).map((name) => `${name}.md`).sort(),
    "agents/ holds exactly the shipped types",
  );
  for (const [name, want] of Object.entries(EXPECTED)) {
    const front = frontmatterOf(path.join(AGENTS, `${name}.md`));
    assert.equal(front.name, name);
    assert.equal(front.model, want.model, name);
    assert.equal(front.effort, want.effort, name);
    assert.ok(front.description.length > 0, name);
    assert.deepEqual(front.disallowedTools.split(",").map((tool) => tool.trim()), want.disallowedTools, name);
    const family = familyOf(front.model);
    assert.ok(dispatchDefaults.models[name]?.includes(family), name);
    assert.ok(dispatchDefaults.models[`${PLUGIN}:${name}`]?.includes(family), name);
  }
});

test("the session note names only the types the plugin ships", () => {
  const named = new Set([...REMINDER.matchAll(/architecture:([a-z-]+)/g)].map((match) => match[1]));
  assert.deepEqual([...named].sort(), Object.keys(EXPECTED).sort());
});

test("the default allowed types are the shipped types, bare and scoped", () => {
  const shipped = Object.keys(EXPECTED).flatMap((name) => [name, `${PLUGIN}:${name}`]);
  assert.deepEqual([...dispatchDefaults.allowedTypes].sort(), shipped.sort());
  assert.deepEqual(dispatchDefaults.implementerTypes, ["sdd-implementer", `${PLUGIN}:sdd-implementer`]);
});
