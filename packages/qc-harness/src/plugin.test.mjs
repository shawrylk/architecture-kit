import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GLOBAL_SKILLS } from "./global-skills.mjs";

const PLUGIN = fileURLToPath(new URL("../../../", import.meta.url));
const EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

test("every kit skill applies only where qc.config.json exists, in its description and in its body", () => {
  const skillRoot = `${PLUGIN}plugins/architecture-extras/skills`;
  const skills = readdirSync(skillRoot);
  assert.ok(skills.length > 0);
  for (const skill of skills.filter((name) => !GLOBAL_SKILLS.includes(name))) {
    const text = readFileSync(`${skillRoot}/${skill}/SKILL.md`, "utf8");
    const description = /^description: (.+)$/m.exec(text)?.[1] ?? "";
    assert.match(description, /only in a repository with a `qc\.config\.json`/, skill);
    assert.match(text, /This skill applies only to a repository with a `qc\.config\.json` at its root/, skill);
  }
});

test("each guard that keeps an edit inside its paths runs on every edit tool", () => {
  const { hooks } = JSON.parse(readFileSync(`${PLUGIN}plugins/architecture-extras/hooks/hooks.json`, "utf8"));
  for (const guard of ["pre-edit-guard.sh", "controller-guard.mjs", "slot-guard.mjs"]) {
    const entry = hooks.PreToolUse.find((group) => group.hooks.some((hook) => hook.command.includes(guard)));
    assert.ok(entry, guard);
    const tools = entry.matcher.split("|");
    for (const tool of EDIT_TOOLS) assert.ok(tools.includes(tool), `${guard} misses ${tool}`);
  }
});

test("core and extras have separate parts and hook paths inside each installed tree", () => {
  const core = JSON.parse(readFileSync(`${PLUGIN}.claude-plugin/plugin.json`, "utf8"));
  const extras = JSON.parse(readFileSync(`${PLUGIN}plugins/architecture-extras/.claude-plugin/plugin.json`, "utf8"));
  assert.equal(core.name, "architecture");
  assert.equal(extras.name, "architecture-extras");
  assert.equal(core.dependencies, undefined);
  const roots = [PLUGIN, `${PLUGIN}plugins/architecture-extras/`];
  for (const kind of ["skills", "agents", "commands"]) {
    const names = roots.map((root) => readdirSync(`${root}${kind}`).sort());
    assert.deepEqual(names[0].filter((name) => names[1].includes(name)), [], kind);
    const expected = { skills: ["codex"], agents: ["codex.md", "sdd-branch-reviewer.md", "sdd-reviewer.md"], commands: ["fleet.md"] };
    assert.deepEqual(names[0], expected[kind], kind);
    const optional = {
      skills: ["applying-engineering-standards", "architecture", "enforcement", "navigating-source-code", "registering-work", "reviewing-before-merge", "security", "swarm", "writing-decision-final-specs", "writing-plain-english"],
      agents: ["sdd-implementer.md", "sdd-planner.md"], commands: ["adopt.md", "check.md", "feature.md"],
    };
    assert.deepEqual(names[1], optional[kind], kind);
  }
  const configured = roots.map((root) => JSON.parse(readFileSync(`${root}hooks/hooks.json`, "utf8")).hooks);
  const coreHooks = [];
  const parts = configured.map((events, index) => {
    const found = new Set();
    for (const [event, groups] of Object.entries(events)) for (const group of groups) for (const hook of group.hooks) {
      const match = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/.exec(hook.command);
      assert.ok(match, hook.command);
      const target = `${roots[index]}${match[1]}`;
      assert.ok(!match[1].split("/").includes(".."), target);
      assert.ok(readFileSync(target).length > 0, target);
      const part = index === 0 ? match[1].split("/").at(-1) : hook.command.split('" ').at(-1);
      found.add(part);
      if (index === 0) coreHooks.push([event, group.matcher ?? "", part]);
    }
    return found;
  });
  assert.deepEqual([...parts[0]].filter((part) => parts[1].has(part)), []);
  assert.deepEqual([...parts[1]].sort(), [
    "bash-edit-guard.mjs", "budget-guard.mjs", "checkpoint.mjs", "controller-guard.mjs", "cost-stop.mjs",
    "dispatch-guard.mjs", "dispatch-reminder.mjs", "explore-guard.mjs", "explore-hint.mjs", "generated-file-guard.mjs",
    "issue-gate.mjs", "plan-stop.mjs", "post-edit-gate.sh", "pr-guard.mjs", "pre-edit-guard.sh", "report-stop.mjs",
    "skill-guard.mjs", "slot-guard.mjs", "stop-gate.sh", "ui-reuse-hint.mjs", "watch-arm.mjs", "worktree-gate.mjs",
  ]);
  for (const name of parts[1]) {
    const file = name.endsWith(".sh") ? `plugins/architecture-extras/hooks/${name}` : `packages/qc-harness/src/cli/${name}`;
    assert.ok(readFileSync(`${PLUGIN}${file}`).length > 0, file);
  }
  assert.deepEqual(coreHooks, [
    ["UserPromptSubmit", "", "comment-watch.mjs"],
    ["UserPromptSubmit", "", "context-watch.mjs"],
    ["PreToolUse", "Bash|PowerShell|REPL", "bash-command-guard.mjs"],
    ["PreToolUse", "Bash|PowerShell|REPL", "merge-guard.mjs"],
    ["PostToolUse", "Bash|PowerShell", "comment-watch.mjs"],
    ["PostToolUse", "*", "context-watch.mjs"],
    ["PostToolUse", "Bash|PowerShell", "merge-guard.mjs"],
    ["PostToolUseFailure", "Bash|PowerShell", "merge-guard.mjs"],
  ]);
  const marketplace = JSON.parse(readFileSync(`${PLUGIN}.claude-plugin/marketplace.json`, "utf8"));
  assert.equal(marketplace.plugins.find((entry) => entry.name === extras.name).source, "./plugins/architecture-extras");
  const settings = JSON.parse(readFileSync(`${PLUGIN}user-config/claude/settings.shared.json`, "utf8"));
  assert.ok(!settings.enabledPlugins?.["architecture-extras@architecture-kit"]);
});


test("core Codex instructions stop new starts on a usage limit", () => {
  for (const file of ["agents/codex.md", "skills/codex/SKILL.md"]) {
    const text = readFileSync(`${PLUGIN}${file}`, "utf8");
    assert.match(text, /EXIT: 2.*stop new starts and tell the owner/);
    assert.doesNotMatch(text, /sdd-implementer/);
  }
});
