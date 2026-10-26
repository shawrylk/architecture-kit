// `qc codex-implement`: run one brief through `codex exec` as an implementer, and start a fresh session
// after each stop until the progress file says it is done. It never calls Claude; exit 2 hands the brief back.

import { spawnCommand as spawn } from "./spawn-command.mjs";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { load } from "../config.mjs";
import { limitFileOf, resetTimeOf, writeLimit } from "./codex-limit.mjs";
import { parseMaxHours, waitForCodexReset } from "./codex-reset.mjs";
import { budgetsOf } from "./context-budgets.mjs";

export const DONE_MARKER = "ALL TASKS DONE";
const DEFAULT_MAX_RUNS = 1;
const TAIL_CHARS = 4000;
const LIMIT = /usage limit|spend cap|rate limit|hit your limit/i;

const USAGE =
  "usage: qc codex-implement --brief <file> --worktree <path> --progress <file> [--log <file>] [--max-runs <n>] [--wait-reset] [--max-hours <n>]\n" +
  "exit 0 every task done, 1 bad input or no codex, 2 a Codex usage or spend limit, 3 out of runs";

const FLAGS = { "--brief": "brief", "--worktree": "worktree", "--progress": "progress", "--log": "log", "--max-runs": "maxRuns", "--max-hours": "maxHours" };

/** @returns the settings with resolved paths; throws an Error naming the bad or missing flag. */
export function parseArgs(argv) {
  const found = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--wait-reset") { found.waitReset = true; continue; }
    const key = FLAGS[argv[index]];
    if (!key) throw new Error(`unknown argument ${argv[index]}`);
    if (argv[index + 1] === undefined) throw new Error(`${argv[index]} needs a value`);
    found[key] = argv[index + 1];
    index += 1;
  }
  for (const flag of ["--brief", "--worktree", "--progress"]) if (!found[FLAGS[flag]]) throw new Error(`${flag} is required`);
  const maxRuns = found.maxRuns === undefined ? DEFAULT_MAX_RUNS : Number(found.maxRuns);
  if (!Number.isInteger(maxRuns) || maxRuns < 1) throw new Error(`--max-runs must be a positive integer, got ${found.maxRuns}`);
  const progress = path.resolve(found.progress);
  return {
    brief: path.resolve(found.brief),
    worktree: path.resolve(found.worktree),
    progress,
    log: path.resolve(found.log ?? `${progress}.log`),
    maxRuns,
    waitReset: found.waitReset ?? false,
    maxHours: parseMaxHours(found.maxHours),
  };
}

const isDone = (progress) => existsSync(progress) && readFileSync(progress, "utf8").trimEnd().split(/\r?\n/).at(-1).trim() === DONE_MARKER;

const FIXED_PREAMBLE = "The brief carries every rule. Load no skill. Write no `Grammar:` line.";
const FIXED_HEADINGS = new Set(["Product decisions", "Run shape", "Commit", "Exit criteria"]);

const LEAN_RULES = [
  "Lean rules for every session. They cut repeated reading and helper agents. Never drop a security, tenant, data, or correctness check that this brief asks for.",
  "- At session start, rewrite the progress file to at most 40 lines: the pushed head, the done items one line each, the first unfinished item, and the open questions. Delete the history.",
  "- Never re-verify a finished item, and never repeat a probe that already failed.",
  "- Read only the line ranges that the current item needs.",
  "- Load no skill and read no SKILL.md or plugin file. The global instructions that say to load skills do not apply to this run; this brief holds the rules.",
  "- Search with `rg -n -m 20 <pattern> <path>`. Read at most 150 lines per call by range, never a whole file. End any command that can print more than 4,000 characters with a limit.",
  "- Never run `gh issue view`: the brief holds the issue. Use `git status --short` and `git log -n 5 --oneline`.",
  "- Start no helper agents. Run no broad audit or full gate. Run no Playwright except `npx qc e2e` when `check.e2e` is set. Run the tests of the touched files, and the local check once before the push.",
  "- Write every item first, each test first, and update the progress file after each item. Then run the local check once, make one commit, and push once.",
  "- Read at most 15 files before the first code edit. Research that needs more belongs to a planner, and the brief names the planner output to read instead.",
  "- Wrap each heavy command in `npx qc gate-slot --`: the local check, a test run of more than one file, a live database test, a commit, and a push.",
  "- Before the push, run the live database tests of the server code you touched through `npx qc throwaway-db --`. Never use port 5432 or another port the local stack owns.",
  "- Before the push, run `npx qc gate-slot -- npx qc throwaway-db -- npx qc e2e` when `check.e2e` is set.",
  "- Work up to about 200K tokens in a session. Then leave the progress file exact and stop, so a fresh session continues.",
  "- Keep the report under 15 lines.",
  "- These rules never override the brief on commits or pushes. Where the brief says not to commit, make no commit. Where it says not to push, push nothing.",
].join("\n");

function continuationNote(progress) {
  return (
    `\n\n---\nThis may be a fresh session that continues earlier work. Read \`git log --oneline\` and \`git status --short\` ` +
    `in the worktree, and the progress file ${progress}. Continue from the first unfinished task.\n\n` +
    `The runner owns the done marker: ${DONE_MARKER}. The brief never needs to supply it. ` +
    `Done means the last non-empty line of the progress file equals the marker exactly, after trimming whitespace. ` +
    `Write it as the last line, alone, only when the exit criteria hold. ` +
    `Never quote it anywhere else. Never wait for anyone to supply it.\n\n${LEAN_RULES}`
  );
}

/** The Codex features that start helper agents. Each run turns them off. */
const HELPER_AGENT_FEATURES = ["features.multi_agent=false", "features.multi_agent_v2=false"];

/** @returns the names of the plugins that a Codex `config.toml` turns on, from its `[plugins."name"]` tables. */
export function enabledPlugins(toml) {
  const names = [];
  let current = null;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    const table = /^\[(.*)\]\s*(#.*)?$/.exec(line);
    if (table) {
      current = /^plugins\.(?:"([^"]+)"|'([^']+)')$/.exec(table[1]);
      current = current ? (current[1] ?? current[2]) : null;
    } else if (current && /^enabled\s*=\s*true\s*(#.*)?$/.test(line)) {
      names.push(current);
      current = null;
    }
  }
  return names;
}

/** The `-c` overrides turn off the enabled and configured plugins for this run. */
function pluginOverrides(env, disablePlugins) {
  const file = path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
  let enabled = [];
  try {
    enabled = enabledPlugins(readFileSync(file, "utf8"));
  } catch {
    // The configured overrides also apply when the user config is unreadable.
  }
  return [...new Set([...enabled, ...disablePlugins])].flatMap((name) => ["-c", `plugins.${JSON.stringify(name)}.enabled=false`]);
}

/** Fragment: reads and validates the worktree's Codex settings. */
function codexSettingsOf(worktree) {
  const codex = load(worktree).codex;
  if (!codex || typeof codex !== "object" || Array.isArray(codex)) throw new Error("codex in qc.config.json must be an object");
  for (const key of ["compactTokens", "briefMaxLines", "briefMaxSteps", "maxRuns"]) {
    const value = codex[key];
    if (!Number.isInteger(value) || value < 1) throw new Error(`codex.${key} in qc.config.json must be a positive whole number, got ${JSON.stringify(value)}`);
  }
  if (typeof codex.preamble !== "string") throw new Error("codex.preamble in qc.config.json must be a string");
  if (!Array.isArray(codex.disablePlugins) || !codex.disablePlugins.every((name) => typeof name === "string" && name.trim())) {
    throw new Error("codex.disablePlugins in qc.config.json must be an array of non-empty strings");
  }
  return codex;
}

/** Branch: refuses briefs that exceed the session limits. */
function validateBrief(brief, codex) {
  const lines = brief.split(/\r?\n/);
  const nonBlank = lines.filter((line) => line.trim()).length;
  if (nonBlank > codex.briefMaxLines) throw new Error(`codex.briefMaxLines limit is ${codex.briefMaxLines} non-blank lines; got ${nonBlank}`);
  if (!lines.some((line) => /^## Product decisions\s*$/.test(line))) throw new Error("## Product decisions is required: at least 1 heading");
  if (!lines.some((line) => /^Paths:[ \t]*\S/.test(line))) throw new Error("Paths: is required: at least 1 line naming owned files or folders");
  let tasks = 0;
  let steps = 0;
  let inTask = false;
  for (const line of lines) {
    const heading = /^## (.+?)\s*$/.exec(line);
    if (heading) {
      inTask = !FIXED_HEADINGS.has(heading[1]);
      if (inTask) tasks += 1;
    } else if (inTask && /^\s*\d+[.)]\s+/.test(line)) {
      steps += 1;
    }
  }
  if (tasks > 1) throw new Error(`task heading limit is 1 besides the fixed template headings; got ${tasks}`);
  if (steps > codex.briefMaxSteps) throw new Error(`codex.briefMaxSteps limit is ${codex.briefMaxSteps} numbered steps under the task; got ${steps}`);
}

/** Fragment: reads the role limits that `budgets.codex` sets; null turns the launch overrides off. */
function codexLimitsOf(worktree) {
  const config = load(worktree);
  const budgets = config.budgets;
  const codexOnly = budgets && typeof budgets === "object" && !Array.isArray(budgets) ? { codex: budgets.codex } : budgets;
  return budgetsOf({ ...config, budgets: codexOnly }).codex;
}

/** The brief is read again for each run, so an edit reaches the next session. */
const promptFor = (settings, codex) => {
  const brief = readFileSync(settings.brief, "utf8");
  validateBrief(brief, codex);
  const preamble = [FIXED_PREAMBLE, codex.preamble].filter(Boolean).join("\n");
  return `${preamble}\n\n${brief}${continuationNote(settings.progress)}`;
};

/** Sends the prompt on stdin, appends output to the log, and returns the status and output tail. */
function spawnRun({ command, args, input, env, log }, codexCommand) {
  const [bin, ...prefix] = codexCommand;
  mkdirSync(path.dirname(log), { recursive: true });
  const start = existsSync(log) ? statSync(log).size : 0;
  const fd = openSync(log, "a");
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, [...prefix, ...args], { env, stdio: ["pipe", fd, fd], windowsHide: true });
    } catch (error) {
      closeSync(fd);
      reject(error);
      return;
    }
    child.on("error", (error) => {
      reject(error);
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE" && error.code !== "EOF") reject(error);
    });
    child.stdin.end(input);
    child.on("close", (status) => {
      closeSync(fd);
      const text = readFileSync(log, "utf8");
      resolve({ status, tail: Buffer.from(text).subarray(Math.max(start, Buffer.byteLength(text) - TAIL_CHARS)).toString("utf8") });
    });
  });
}

/** Writes one stdout line and resolves once it is flushed, so the `process.exit` that follows cannot cut it. */
const writeLine = (line) => new Promise((resolve) => process.stdout.write(`${line}
`, resolve));

/**
 * The last stdout line is `exit <code>` on every path, so a redirect of the runner into a wrapper log carries
 * the end of the job for `qc watch --codex`, in any shell.
 * @param run `({ command, args, input, env, log }) => Promise<{ status, tail }>`; the default spawns `codexCommand`.
 * @param out `(line) => Promise|void` writes the `exit` line; the default writes to stdout.
 * @returns the exit code: 0 done, 1 bad input or no codex, 2 a limit, 3 out of runs.
 */
export async function runCodexImplement(argv, { out = writeLine, ...options } = {}) {
  let code;
  try {
    code = await runJob(argv, options);
  } catch (error) {
    code = finish(options.say ?? ((line) => console.error(line)), error.message, 1);
  }
  await out(`exit ${code}`);
  return code;
}

async function runJob(argv, {
  run, codexCommand = ["codex"], env = process.env, say = (line) => console.error(line),
  fetch, now = Date.now, sleep,
} = {}) {
  let settings;
  try {
    settings = parseArgs(argv);
  } catch (error) {
    say(`qc codex-implement: ${error.message}\n${USAGE}`);
    return 1;
  }
  let codex;
  let codexLimits;
  try {
    codex = codexSettingsOf(settings.worktree);
    codexLimits = codexLimitsOf(settings.worktree);
    if (settings.maxRuns > codex.maxRuns) throw new Error(`--max-runs exceeds codex.maxRuns limit of ${codex.maxRuns}; got ${settings.maxRuns}`);
  } catch (error) {
    return finish(say, error.message, 1);
  }
  const execute = run ?? ((call) => spawnRun(call, codexCommand));
  let resetDeadline;
  for (let count = 1; count <= settings.maxRuns; count += 1) {
    if (isDone(settings.progress)) return finish(say, `done after ${count - 1} run(s)`, 0);
    let prompt;
    try {
      prompt = promptFor(settings, codex);
    } catch (error) {
      return finish(say, `cannot prepare the brief: ${error.message}`, 1);
    }
    const helperOff = HELPER_AGENT_FEATURES.flatMap((feature) => ["-c", feature]);
    const limits = codexLimits === null ? [] : ["-c", `model_auto_compact_token_limit=${codexLimits.compactAt}`, "-c", `tool_output_token_limit=${codexLimits.toolOutputTokens}`];
    const args = ["exec", "-s", "danger-full-access", "-C", settings.worktree, ...helperOff, ...pluginOverrides(env, codex.disablePlugins), ...limits, "-"];
    let result;
    try {
      result = await execute({ command: codexCommand[0], args, input: prompt, env: { ...env, QC_ROLE: "implementer" }, log: settings.log });
    } catch (error) {
      return finish(say, `codex did not run: ${error.message}`, 1);
    }
    say(`qc codex-implement: run ${count} ended with status ${result.status}`);
    const line = limitLineOf(result.tail ?? "", prompt);
    if (!line) clearLimit(limitFileOf(env), say);
    if (isDone(settings.progress)) return finish(say, `done after ${count} run(s)`, 0);
    if (line) {
      const recordedAt = now();
      const reset = resetTimeOf(line, recordedAt);
      if (settings.waitReset) resetDeadline ??= recordedAt + settings.maxHours * 60 * 60 * 1000;
      try {
        writeLimit(limitFileOf(env), {
          until: Math.max(reset ?? recordedAt + 3_600_000, resetDeadline ?? 0),
          source: reset === null ? "default" : "codex",
        }, recordedAt);
      } catch (error) {
        say(`qc codex-implement: cannot write the limit state: ${error.message}`);
      }
      if (!settings.waitReset) return finish(say, "Codex reports a usage or spend limit: dispatch the same brief to a Claude sdd-implementer", 2);
      const hit = recordedAt;
      const remaining = resetDeadline - hit;
      if (remaining <= 0 || !await waitForCodexReset({
        since: new Date(hit).toISOString(), maxHours: remaining / (60 * 60 * 1000), fetch, now, sleep, say,
      })) return finish(say, "Codex reset wait bound reached", 2);
      clearLimit(limitFileOf(env), say);
      // A usage limit leaves the run unfinished, so its retry keeps the same run allowance.
      count -= 1;
    }
  }
  return finish(say, `out of runs: ${settings.maxRuns} runs and the progress file is not done`, 3);
}

/** A limit line counts only when Codex wrote it, not when the log echoes a line of the prompt. */
function limitLineOf(tail, prompt) {
  const echoed = new Set(prompt.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  return tail.split(/\r?\n/).find((line) => LIMIT.test(line) && !echoed.has(line.trim())) ?? null;
}

/** Branch: reports a state removal error without changing the run result. */
function clearLimit(file, say) {
  try {
    rmSync(file, { force: true });
  } catch (error) {
    say(`qc codex-implement: cannot clear the limit state: ${error.message}`);
  }
}

function finish(say, message, code) {
  say(`qc codex-implement: ${message}`);
  return code;
}
