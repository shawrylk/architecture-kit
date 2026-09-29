import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dispatchDefaults } from "../config.mjs";
import { familyOf } from "./dispatch.mjs";
import { REMINDER } from "./dispatch-reminder.mjs";

const AGENTS = fileURLToPath(new URL("../../../../agents/", import.meta.url));
const README = fileURLToPath(new URL("../../../../README.md", import.meta.url));
const PLUGIN = "architecture";
// The built-in tools a background subagent keeps, as the Claude Code sub-agents page lists them.
// Claude Code drops any other listed name without an error, so such a name is dead weight.
const SUBAGENT_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LSP",
  "Bash",
  "PowerShell",
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Skill",
  "ToolSearch",
  "EnterWorktree",
  "ExitWorktree",
  "Monitor",
  "TaskStop",
  "SendMessage",
  "Artifact",
  "SubagentHandback",
]);
// Tools every platform has, so no list can resolve to nothing and refuse to launch.
const ALWAYS_PRESENT = ["Read", "Bash"];
const READ_TOOLS = ["Read", "Grep", "Glob", "Bash", "PowerShell", "Skill"];
const EDIT_TOOLS = [...READ_TOOLS, "Edit", "Write"];
const EXPECTED = {
  "sdd-implementer": { model: "sonnet", effort: "high", tools: EDIT_TOOLS },
  "sdd-planner": { model: "opus", effort: "high", tools: EDIT_TOOLS },
  "sdd-reviewer": { model: "sonnet", effort: "high", tools: READ_TOOLS },
  "sdd-branch-reviewer": { model: "opus", effort: "high", tools: READ_TOOLS },
};
// Fields Claude Code ignores on a plugin agent, and the one that drops a repository's CLAUDE.md and rules.
const FORBIDDEN_FIELDS = ["disallowedTools", "hooks", "mcpServers", "permissionMode", "omitClaudeMd"];

const listOf = (value) =>
  (value ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter((tool) => tool !== "");

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

/** Each README table row for a shipped type, as its bare name and the backticked names in its Tools cell. */
function readmeToolsOf(markdown) {
  const rows = markdown.split(/\r?\n/).filter((line) => line.startsWith(`| \`${PLUGIN}:`));
  return Object.fromEntries(
    rows.map((row) => {
      const cells = row.split("|").map((cell) => cell.trim());
      const name = cells[1].replace(/`/g, "").slice(PLUGIN.length + 1);
      return [name, [...cells[4].matchAll(/`([^`]+)`/g)].map((match) => match[1])];
    }),
  );
}

const frontOf = (name) => frontmatterOf(path.join(AGENTS, `${name}.md`));

test("each subagent type runs on its model tier at its effort, with its own tool list", () => {
  assert.deepEqual(
    readdirSync(AGENTS).sort(),
    Object.keys(EXPECTED).map((name) => `${name}.md`).sort(),
    "agents/ holds exactly the shipped types",
  );
  for (const [name, want] of Object.entries(EXPECTED)) {
    const front = frontOf(name);
    assert.equal(front.name, name);
    assert.equal(front.model, want.model, name);
    assert.equal(front.effort, want.effort, name);
    assert.ok(front.description.length > 0, name);
    assert.deepEqual(listOf(front.tools), want.tools, name);
    const family = familyOf(front.model);
    assert.ok(dispatchDefaults.models[name]?.includes(family), name);
    assert.ok(dispatchDefaults.models[`${PLUGIN}:${name}`]?.includes(family), name);
  }
});

test("each listed tool is one a subagent keeps, never Agent and never an MCP tool, and Read and Bash are always there", () => {
  for (const name of Object.keys(EXPECTED)) {
    const tools = listOf(frontOf(name).tools);
    assert.ok(!tools.includes("Agent"), `${name} can dispatch a subagent`);
    for (const tool of tools) {
      assert.ok(!tool.startsWith("mcp__"), `${name} lists the MCP tool ${tool}`);
      assert.ok(SUBAGENT_TOOLS.has(tool), `${name} lists ${tool}, which no subagent keeps`);
    }
    for (const tool of ALWAYS_PRESENT) assert.ok(tools.includes(tool), `${name} lacks ${tool}`);
  }
});

test("no type sets a field a plugin agent ignores, or one that drops the repository's CLAUDE.md", () => {
  for (const name of Object.keys(EXPECTED)) {
    const front = frontOf(name);
    for (const field of FORBIDDEN_FIELDS) assert.equal(front[field], undefined, `${name} sets ${field}`);
  }
});

test("the README table gives each shipped type the tools its definition lists, and no other type", () => {
  const documented = readmeToolsOf(readFileSync(README, "utf8"));
  assert.deepEqual(Object.keys(documented).sort(), Object.keys(EXPECTED).sort());
  for (const [name, want] of Object.entries(EXPECTED)) assert.deepEqual(documented[name], want.tools, name);
});

test("the README reader takes a CRLF checkout and skips the rows of other tables", () => {
  const text = [
    "| Type | Model | Effort | Tools | Role |",
    "|---|---|---|---|---|",
    "| `architecture:sdd-reviewer` | `sonnet` | `high` | `Read`, `Bash` | reviews one task |",
    "| `allowedTypes` | the four types | the types that may omit `model` |",
    "",
  ].join("\r\n");
  assert.deepEqual(readmeToolsOf(text), { "sdd-reviewer": ["Read", "Bash"] });
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
