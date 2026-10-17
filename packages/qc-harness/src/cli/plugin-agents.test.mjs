import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dispatchDefaults, runtimeModels } from "../config.mjs";
import { REMINDER } from "./dispatch-reminder.mjs";
import { dispatchRefusal, dispatchSettings } from "./dispatch.mjs";

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
// A reviewer has no Skill tool: it brings the whole skill listing, so a review brief states its criteria.
const READ_TOOLS = ["Read", "Grep", "Glob", "Bash", "PowerShell"];
const EDIT_TOOLS = [...READ_TOOLS, "Skill", "Edit", "Write"];
const EXPECTED = {
  "sdd-implementer": { model: "inherit", effort: "high", tools: EDIT_TOOLS },
  "sdd-planner": { model: "inherit", effort: "high", tools: EDIT_TOOLS },
  "sdd-reviewer": { model: "inherit", effort: "high", tools: READ_TOOLS },
  "sdd-branch-reviewer": { model: "inherit", effort: "high", tools: READ_TOOLS },
};
// The watcher runs one `qc codex-implement` job. It reads no source, so it needs Bash alone and the cheapest model.
const WATCHER = { codex: { model: "haiku", effort: undefined, tools: ["Bash"] } };
const SHIPPED = { ...EXPECTED, ...WATCHER };
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

test("each subagent type inherits the session model, has a model in every runtime, and keeps its effort and tool list", () => {
  assert.deepEqual(
    readdirSync(AGENTS).sort(),
    Object.keys(SHIPPED).map((name) => `${name}.md`).sort(),
    "agents/ holds exactly the shipped types",
  );
  for (const [name, want] of Object.entries(EXPECTED)) {
    const front = frontOf(name);
    assert.equal(front.name, name);
    assert.equal(front.model, want.model, name);
    assert.equal(front.effort, want.effort, name);
    assert.ok(front.description.length > 0, name);
    assert.deepEqual(listOf(front.tools), want.tools, name);
    for (const models of Object.values(runtimeModels)) {
      assert.ok(models[name]?.length > 0, name);
      assert.deepEqual(models[`${PLUGIN}:${name}`], models[name], name);
    }
  }
});

test("each listed tool is one a subagent keeps, never Agent and never an MCP tool, and Bash is always there", () => {
  for (const name of Object.keys(SHIPPED)) {
    const tools = listOf(frontOf(name).tools);
    assert.ok(!tools.includes("Agent"), `${name} can dispatch a subagent`);
    for (const tool of tools) {
      assert.ok(!tool.startsWith("mcp__"), `${name} lists the MCP tool ${tool}`);
      assert.ok(SUBAGENT_TOOLS.has(tool), `${name} lists ${tool}, which no subagent keeps`);
    }
    assert.ok(tools.includes("Bash"), `${name} lacks Bash`);
    if (name in EXPECTED) assert.ok(tools.includes("Read"), `${name} lacks Read`);
  }
});

test("no type sets a field a plugin agent ignores, or one that drops the repository's CLAUDE.md", () => {
  for (const name of Object.keys(SHIPPED)) {
    const front = frontOf(name);
    for (const field of FORBIDDEN_FIELDS) assert.equal(front[field], undefined, `${name} sets ${field}`);
  }
});

test("the README table gives each shipped type the tools its definition lists, and no other type", () => {
  const documented = readmeToolsOf(readFileSync(README, "utf8"));
  assert.deepEqual(Object.keys(documented).sort(), Object.keys(SHIPPED).sort());
  for (const [name, want] of Object.entries(SHIPPED)) assert.deepEqual(documented[name], want.tools, name);
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

test("no type pins a prompt cache lifetime, so a user's own setting decides it", () => {
  // The measured one-hour lifetime cost more for all four types; `qc tokens` reports it per session.
  for (const name of Object.keys(SHIPPED)) {
    const front = frontOf(name);
    assert.equal(front.experimental, undefined, `${name} sets experimental`);
    assert.equal(front.cacheTtl, undefined, `${name} sets cacheTtl`);
  }
});

test("both reviewers review only the increment when the dispatch carries a Reviewed line, and still put the verdict first", () => {
  for (const name of ["sdd-reviewer", "sdd-branch-reviewer"]) {
    const text = readFileSync(path.join(AGENTS, `${name}.md`), "utf8").replace(/\r/g, "");
    assert.match(text, /`Reviewed: <sha>`/, name);
    assert.match(text, /<sha>\.\.<head>/, name);
    assert.match(text, /only that increment|only the increment/i, name);
    assert.match(text, /Without the line, review as before/, name);
    assert.ok(text.indexOf("`Reviewed: <sha>`") < text.indexOf("`VERDICT: APPROVED <sha>`"), `${name} keeps the verdict line rule last`);
  }
});

test("the codex watcher runs on haiku with Bash alone, and the guard accepts haiku or sonnet for it", () => {
  const front = frontOf("codex");
  assert.equal(front.name, "codex");
  assert.equal(front.model, WATCHER.codex.model);
  assert.deepEqual(listOf(front.tools), WATCHER.codex.tools);
  for (const type of ["codex", `${PLUGIN}:codex`]) assert.deepEqual(runtimeModels.claude[type], ["haiku", "sonnet"], type);
  const settings = dispatchSettings({ dispatch: {} }, "claude");
  for (const model of ["haiku", "sonnet"]) {
    assert.equal(dispatchRefusal({ subagent_type: `${PLUGIN}:codex`, model, prompt: "Brief: b" }, settings), null, model);
  }
  assert.match(dispatchRefusal({ subagent_type: `${PLUGIN}:codex`, model: "opus", prompt: "Brief: b" }, settings) ?? "", /haiku, sonnet/);
});

test("the codex watcher starts one background job and polls the wrapper file with until grep", () => {
  const text = readFileSync(path.join(AGENTS, "codex.md"), "utf8").replace(/\r/g, "");
  assert.ok(text.includes("run_in_background: true"));
  assert.ok(text.includes("codex-implement --brief"));
  assert.ok(text.includes("until grep -q"));
  assert.ok(text.includes("Never pipe `tail -f` into `grep -m1`"));
  assert.ok(!/^\s*tail -f/m.test(text), "no step runs tail -f");
});
