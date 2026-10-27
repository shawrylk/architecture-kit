#!/usr/bin/env node
// Run Claude Code or Codex on the fixture, with or without the kit, and grade each run with checks
// the agent never sees. One JSON line per run goes to <out>/results.jsonl. See README.md.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const { values: args } = parseArgs({
  args: isMain ? process.argv.slice(2) : [],
  options: {
    agent: { type: "string", default: "claude" },
    arm: { type: "string", default: "none" },
    kit: { type: "string" },
    label: { type: "string" },
    tasks: { type: "string", default: readdirSync(path.join(here, "tasks")).join(",") },
    reps: { type: "string", default: "1" },
    parallel: { type: "string", default: "3" },
    model: { type: "string" },
    budget: { type: "string", default: "3" },
    "timeout-min": { type: "string", default: "25" },
    work: { type: "string", default: path.join(os.tmpdir(), "qc-agent-eval") },
    out: { type: "string" },
  },
});

// `noop` changes nothing and `reference` applies the known solution: together they prove the grader.
if (!["claude", "codex", "noop", "reference"].includes(args.agent)) throw new Error(`--agent is claude, codex, noop or reference, not ${args.agent}`);
if (!["none", "kit"].includes(args.arm)) throw new Error(`--arm is none or kit, not ${args.arm}`);
if (args.arm === "kit" && !args.kit) throw new Error("--arm kit needs --kit <path to a kit checkout>");
const kit = args.kit ? path.resolve(args.kit) : undefined;
const label = args.label ?? args.arm;
if (isMain) mkdirSync(args.work, { recursive: true });
// The long form of the path: Claude Code refuses an edit under an 8.3 short name such as NGUYEN~1.
if (isMain) args.work = realpathSync.native(args.work);
const outPath = path.resolve(args.out ?? path.join(args.work, "results"));
if (isMain) mkdirSync(outPath, { recursive: true });
const out = isMain ? realpathSync.native(outPath) : outPath;

/** Branch: an assistant Skill call names the exact expected skill in the run transcript. */
export function skillActivationOf(transcript, expected) {
  if (!existsSync(transcript)) return false;
  return readFileSync(transcript, "utf8").split(/\r?\n/).some((line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return false;
    }
    const content = event?.message?.content;
    return event?.type === "assistant" && Array.isArray(content) && content.some((block) =>
      block?.type === "tool_use" && block.name === "Skill" && block.input?.skill === expected);
  });
}

const expectedSkillOf = (task) => {
  const file = path.join(here, "tasks", task, "expected-skill.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).skill : null;
};

function run(cmd, cmdArgs, cwd, options = {}) {
  const result = spawnSync(cmd, cmdArgs, { cwd, encoding: "utf8", shell: options.shell ?? false, env: options.env ?? process.env, maxBuffer: 1 << 26 });
  return { code: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// One install of the fixture's dev dependencies, shared by every run through links.
function ensureDeps() {
  const deps = path.join(args.work, "deps");
  if (existsSync(path.join(deps, "node_modules", "typescript"))) return deps;
  mkdirSync(deps, { recursive: true });
  cpSync(path.join(here, "fixture", "package.json"), path.join(deps, "package.json"));
  const install = run("npm", ["install", "--no-audit", "--no-fund"], deps, { shell: true });
  if (install.code !== 0) throw new Error(`npm install failed:\n${install.output}`);
  return deps;
}

// A private node_modules that links each shared package, so a run's caches stay its own.
function linkNodeModules(repo, deps) {
  const target = path.join(repo, "node_modules");
  const shared = path.join(deps, "node_modules");
  mkdirSync(path.join(target, ".bin"), { recursive: true });
  for (const entry of readdirSync(shared)) {
    if (entry === ".bin" || entry.startsWith(".")) continue;
    symlinkSync(path.join(shared, entry), path.join(target, entry), "junction");
  }
  cpSync(path.join(shared, ".bin"), path.join(target, ".bin"), { recursive: true });
  if (!kit) return;
  symlinkSync(path.join(kit, "packages", "qc-harness"), path.join(target, "architecture-harness"), "junction");
  writeFileSync(path.join(target, ".bin", "qc"), '#!/bin/sh\nexec node "$(dirname "$0")/../architecture-harness/src/cli/qc.mjs" "$@"\n', { mode: 0o755 });
  writeFileSync(path.join(target, ".bin", "qc.cmd"), '@node "%~dp0\\..\\architecture-harness\\src\\cli\\qc.mjs" %*\r\n');
}

const PRESET_CONFIG = `import { preset } from "architecture-harness/preset";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import boundaries from "eslint-plugin-boundaries";
import sonarjs from "eslint-plugin-sonarjs";

export default preset({
  plugins: { tseslint, boundaries, sonarjs },
  languageOptions: { parser: tsparser, ecmaVersion: 2023, sourceType: "module" },
});
`;

// What an adopter of a flat repository does: run `qc init`, use the preset, and declare no feature roots.
function adopt(repo) {
  const qc = path.join(kit, "packages", "qc-harness", "src", "cli", "qc.mjs");
  const init = run("node", [qc, "init"], repo);
  writeFileSync(path.join(repo, "eslint.config.mjs"), PRESET_CONFIG);
  const config = JSON.parse(readFileSync(path.join(repo, "qc.config.json"), "utf8"));
  config.featureRoots = [];
  writeFileSync(path.join(repo, "qc.config.json"), `${JSON.stringify(config, null, 2)}\n`);
  return init.output;
}

function prepare(dir, deps) {
  const repo = path.join(dir, "repo");
  rmSync(dir, { recursive: true, force: true });
  cpSync(path.join(here, "fixture"), repo, { recursive: true });
  linkNodeModules(repo, deps);
  writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  const adoption = kit && args.arm === "kit" ? adopt(repo) : "";
  const git = (...a) => run("git", a, repo);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "eval@example.com");
  git("config", "user.name", "eval");
  git("config", "core.autocrlf", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: initial commit");
  // The hooks bind only after the first commit, so the starting tree needs no green pass.
  if (args.arm === "kit") git("config", "core.hooksPath", ".githooks");
  else git("config", "core.hooksPath", ".git/hooks");
  return { repo, adoption };
}

// The checks the kit reports on the untouched fixture: what an adopter has to fix first.
function adoptionCost(repo) {
  if (args.arm !== "kit") return undefined;
  const lint = run("node", [path.join(repo, "node_modules", "eslint", "bin", "eslint.js"), ".", "--max-warnings", "0", "-f", "json"], repo);
  let lintProblems = 0;
  try {
    lintProblems = JSON.parse(lint.output.slice(lint.output.indexOf("["), lint.output.lastIndexOf("]") + 1)).reduce((sum, file) => sum + file.errorCount + file.warningCount, 0);
  } catch {
    lintProblems = lint.code === 0 ? 0 : -1;
  }
  const check = run("node", [path.join(repo, "node_modules", "architecture-harness", "src", "cli", "qc.mjs"), "check"], repo);
  const checkFailures = (check.output.match(/^FAIL/gm) ?? []).length;
  return { lintProblems, checkCode: check.code, checkFailures, checkOutput: check.output.slice(0, 4000) };
}

function claudeArgs() {
  const list = ["-p", "--output-format", "stream-json", "--verbose", "--setting-sources", "project,local", "--no-session-persistence"];
  list.push("--permission-mode", "acceptEdits", "--allowedTools", "Bash", "Read", "Edit", "Write", "Glob", "Grep", "Skill", "--max-budget-usd", args.budget);
  if (args.model) list.push("--model", args.model);
  if (args.arm === "kit") list.push("--plugin-dir", kit);
  return list;
}

// Every plugin the user's Codex config enables is off for the run, so only the kit differs between arms.
function codexArgs(repo) {
  const list = ["exec", "-s", "workspace-write", "-C", repo, "--json", "--skip-git-repo-check"];
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const config = existsSync(path.join(home, "config.toml")) ? readFileSync(path.join(home, "config.toml"), "utf8") : "";
  for (const match of config.matchAll(/^\[plugins\."([^"]+)"\]\s*\n\s*enabled\s*=\s*true/gm)) list.push("-c", `plugins."${match[1]}".enabled=false`);
  if (args.model) list.push("-m", args.model);
  list.push("-");
  return list;
}

function runAgent(repo, prompt, transcript, task) {
  if (args.agent === "noop") return { exitCode: 0, seconds: 0 };
  if (args.agent === "reference") {
    const skill = expectedSkillOf(task);
    if (skill) writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: {
      content: [{ type: "tool_use", id: "reference-skill", name: "Skill", input: { skill } }],
    } })}\n`);
    cpSync(path.join(here, "tasks", task, "solution"), path.join(repo, "src"), { recursive: true });
    run("git", ["add", "-A"], repo);
    run("git", ["commit", "-q", "-m", "fix: apply the reference solution"], repo);
    return { exitCode: 0, seconds: 0 };
  }
  const [cmd, cmdArgs] = args.agent === "claude" ? ["claude", claudeArgs()] : ["codex", codexArgs(repo)];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { cwd: repo, env: { ...process.env, CLAUDE_PROJECT_DIR: repo } });
    const timer = setTimeout(() => {
      if (isWindows) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      else child.kill("SIGKILL");
    }, Number(args["timeout-min"]) * 60_000);
    child.stdout.on("data", (d) => appendFileSync(transcript, d));
    child.stderr.on("data", (d) => appendFileSync(`${transcript}.err`, d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, seconds: Math.round((Date.now() - started) / 1000) });
    });
    child.stdin.end(prompt);
  });
}

function usageOf(transcript) {
  const lines = existsSync(transcript) ? readFileSync(transcript, "utf8").split("\n").filter(Boolean) : [];
  const events = lines.flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  if (args.agent === "claude") {
    const blocks = events.filter((e) => e.type === "user").flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []));
    // A Stop refusal comes back as a user text. A PreToolUse or PostToolUse refusal is a failed tool result that names the hook.
    const stopBlocks = blocks.filter((b) => b.type === "text" && b.text.startsWith("Stop hook feedback")).length;
    const toolBlocks = blocks.filter((b) => b.type === "tool_result" && b.is_error && /hook/i.test(JSON.stringify(b.content))).length;
    const uses = new Map(events.filter((e) => e.type === "assistant").flatMap((e) => e.message?.content ?? []).filter((c) => c.type === "tool_use").map((c) => [c.id, c]));
    const gitFails = blocks.filter((b) => b.type === "tool_result" && b.is_error && /\bgit (?:commit|push)\b/.test(uses.get(b.tool_use_id)?.input?.command ?? "")).length;
    const result = events.findLast((e) => e.type === "result") ?? {};
    const toolCalls = events.filter((e) => e.type === "assistant").flatMap((e) => e.message?.content ?? []).filter((c) => c.type === "tool_use").length;
    const usage = result.usage ?? {};
    return {
      costUsd: result.total_cost_usd ?? null,
      turns: result.num_turns ?? null,
      toolCalls,
      inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? 0,
      hookBlocks: stopBlocks + toolBlocks,
      stopBlocks,
      toolBlocks,
      gitFails,
      finished: result.subtype ?? "none",
    };
  }
  const turns = events.filter((e) => e.type === "turn.completed");
  const items = events.filter((e) => e.type === "item.completed").map((e) => e.item ?? {});
  const toolCalls = items.filter((item) => ["command_execution", "file_change"].includes(item.type)).length;
  // Codex runs no kit hook of its own: the kit reaches it only through the git hooks.
  const gitFails = items.filter((item) => item.type === "command_execution" && /\bgit (?:commit|push)\b/.test(item.command ?? "") && item.exit_code !== 0).length;
  return {
    costUsd: null,
    turns: turns.length,
    toolCalls,
    inputTokens: turns.reduce((sum, e) => sum + (e.usage?.input_tokens ?? 0), 0),
    outputTokens: turns.reduce((sum, e) => sum + (e.usage?.output_tokens ?? 0), 0),
    hookBlocks: 0,
    stopBlocks: 0,
    toolBlocks: 0,
    gitFails,
    finished: turns.length > 0 ? "success" : "none",
  };
}

const NEUTRAL_LINT = readFileSync(path.join(here, "fixture", "eslint.config.mjs"), "utf8");

// Graded after the run, with files the agent never saw: the hidden tests, tsc, and the plain lint config.
function grade(repo, task, transcript) {
  const expectedSkill = expectedSkillOf(task);
  const skillActivated = expectedSkill ? skillActivationOf(transcript, expectedSkill) : null;
  const git = (...a) => run("git", a, repo).output.trim();
  const commits = Number(git("rev-list", "--count", "HEAD")) - 1;
  const dirty = git("status", "--porcelain").split("\n").filter(Boolean).length;
  // Every file the run changed, committed or not, against the starting commit.
  const root = git("rev-list", "--max-parents=0", "HEAD");
  const changed = [...git("diff", "--name-only", root).split("\n"), ...git("ls-files", "--others", "--exclude-standard").split("\n")];
  const touched = [...new Set(changed.filter(Boolean))];
  // A change to a file the reference solution leaves alone, other than a test, is scope the task never asked for.
  const scope = new Set(readdirSync(path.join(here, "tasks", task, "solution")).map((f) => `src/${f}`));
  const outOfScope = touched.filter((f) => !scope.has(f) && !f.endsWith(".test.ts"));
  cpSync(path.join(here, "tasks", task, "hidden.test.ts"), path.join(repo, "src", "hidden.test.ts"));
  mkdirSync(path.join(repo, ".eval"), { recursive: true });
  writeFileSync(path.join(repo, ".eval", "eslint.config.mjs"), NEUTRAL_LINT);
  const tap = (file) => {
    const result = run("node", ["--test", "--test-reporter=tap", ...file], repo);
    const count = (name) => Number(result.output.match(new RegExp(`^# ${name} (\\d+)`, "m"))?.[1] ?? 0);
    return { pass: count("pass"), fail: count("fail") };
  };
  const hidden = tap(["src/hidden.test.ts"]);
  const visible = tap(readdirSync(path.join(repo, "src")).filter((f) => f.endsWith(".test.ts") && f !== "hidden.test.ts").map((f) => `src/${f}`));
  const tsc = run("node", [path.join(repo, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", "."], repo);
  const lint = run("node", [path.join(repo, "node_modules", "eslint", "bin", "eslint.js"), "-c", ".eval/eslint.config.mjs", "src"], repo);
  return {
    hiddenPass: hidden.pass,
    hiddenFail: hidden.fail,
    solved: hidden.fail === 0 && hidden.pass > 0 && skillActivated !== false,
    ...(expectedSkill ? { expectedSkill, skillActivated } : {}),
    visibleFail: visible.fail,
    typecheck: tsc.code === 0,
    lint: lint.code === 0,
    commits,
    dirty,
    touched,
    outOfScope,
    tscOutput: tsc.code === 0 ? "" : tsc.output.slice(0, 2000),
  };
}

// The Codex sandbox keeps `.git` read-only, so Codex cannot commit. The runner commits what it left, through
// the repository's git hooks: the one path by which the kit reaches Codex. Null when Codex committed or changed nothing.
function commitForAgent(repo) {
  if (run("git", ["status", "--porcelain"], repo).output.trim() === "") return null;
  run("git", ["add", "-A"], repo);
  const commit = run("git", ["commit", "-q", "-m", "fix: apply the change of the agent"], repo);
  return { passed: commit.code === 0, output: commit.output.slice(0, 2000) };
}

async function one(task, rep, deps) {
  const dir = path.join(out, `${label}-${args.agent}-${task}-${rep}`);
  const { repo, adoption } = prepare(dir, deps);
  const cost = adoptionCost(repo);
  const prompt = readFileSync(path.join(here, "tasks", task, "prompt.md"), "utf8");
  const transcript = path.join(dir, "transcript.jsonl");
  console.log(`start ${path.basename(dir)}`);
  const agent = await runAgent(repo, prompt, transcript, task);
  const hookCommit = args.agent === "codex" ? commitForAgent(repo) : undefined;
  const record = { label, agent: args.agent, arm: args.arm, task, rep, ...agent, ...usageOf(transcript), hookCommit, ...grade(repo, task, transcript), adoption: cost, initOutput: adoption.slice(0, 1000) };
  appendFileSync(path.join(out, "results.jsonl"), `${JSON.stringify(record)}\n`);
  console.log(`done  ${path.basename(dir)} solved=${record.solved} tsc=${record.typecheck} lint=${record.lint} ${record.seconds}s blocks=${record.hookBlocks} gitFails=${record.gitFails} outOfScope=${record.outOfScope.join(",")}`);
}

if (isMain) {
const deps = ensureDeps();
const jobs = args.tasks.split(",").flatMap((task) => Array.from({ length: Number(args.reps) }, (_, i) => [task, i + 1]));
const pool = Array.from({ length: Number(args.parallel) }, async () => {
  while (jobs.length > 0) {
    const [task, rep] = jobs.shift();
    await one(task, rep, deps).catch((error) => console.error(`error ${task}-${rep}: ${error.stack}`));
  }
});
await Promise.all(pool);
}
