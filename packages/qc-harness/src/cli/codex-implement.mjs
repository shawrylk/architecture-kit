// `qc codex-implement`: run one brief through `codex exec` as an implementer, and start a fresh session
// after each stop until the progress file says it is done. It never calls Claude; exit 2 hands the brief back.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const DONE_MARKER = "ALL TASKS DONE";
const DEFAULT_MAX_RUNS = 12;
const TAIL_CHARS = 4000;
const LIMIT = /usage limit|spend cap|rate limit|hit your limit/i;

const USAGE =
  "usage: qc codex-implement --brief <file> --worktree <path> --progress <file> [--log <file>] [--max-runs <n>]\n" +
  "exit 0 every task done, 1 bad input or no codex, 2 a Codex usage or spend limit, 3 out of runs";

const FLAGS = { "--brief": "brief", "--worktree": "worktree", "--progress": "progress", "--log": "log", "--max-runs": "maxRuns" };

/** @returns the settings with resolved paths; throws an Error naming the bad or missing flag. */
export function parseArgs(argv) {
  const found = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = FLAGS[argv[index]];
    if (!key) throw new Error(`unknown argument ${argv[index]}`);
    if (argv[index + 1] === undefined) throw new Error(`${argv[index]} needs a value`);
    found[key] = argv[index + 1];
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
  };
}

const isDone = (progress) => existsSync(progress) && readFileSync(progress, "utf8").includes(DONE_MARKER);

const LEAN_RULES = [
  "Lean rules for every session. They cut repeated reading and helper agents. Never drop a security, tenant, data, or correctness check that this brief asks for.",
  "- At session start, rewrite the progress file to at most 40 lines: the pushed head, the done items one line each, the first unfinished item, and the open questions. Delete the history.",
  "- Never re-verify a finished item, and never repeat a probe that already failed.",
  "- Read only the line ranges that the current item needs.",
  "- Start no helper agents. Run no broad audit, no Playwright, and no full gate. Run the tests of the touched files, and the local check once before the push.",
  "- Write every item first, each test first, and update the progress file after each item. Then run the local check once, make one commit, and push once.",
  "- Read at most 15 files before the first code edit. Research that needs more belongs to a planner, and the brief names the planner output to read instead.",
  "- Wrap each heavy command in `npx qc gate-slot --`: the local check, a test run of more than one file, a live database test, a commit, and a push.",
  "- Before the push, run the live database tests of the server code you touched through `npx qc throwaway-db --`. Never use port 5432 or another port the local stack owns.",
  "- Work up to about 200K tokens in a session. Then leave the progress file exact and stop, so a fresh session continues.",
  "- Keep the report under 15 lines.",
].join("\n");

function continuationNote(progress) {
  return (
    `\n\n---\nThis may be a fresh session that continues earlier work. Read \`git log --oneline\` and \`git status --short\` ` +
    `in the worktree, and the progress file ${progress}. Continue from the first unfinished task.\n\n${LEAN_RULES}`
  );
}

/** The Codex features that start helper agents. Each run turns them off. */
const HELPER_AGENT_FEATURES = ["features.multi_agent=false", "features.multi_agent_v2=false"];

/** The brief is read again for each run, so an edit reaches the next session. */
const promptFor = (settings) => readFileSync(settings.brief, "utf8") + continuationNote(settings.progress);

/** Runs one codex process with no shell and a closed stdin, appends its output to the log, and resolves with the exit status and the output tail. */
function spawnRun({ command, args, env, log }, codexCommand) {
  const [bin, ...prefix] = codexCommand;
  mkdirSync(path.dirname(log), { recursive: true });
  const start = existsSync(log) ? statSync(log).size : 0;
  const fd = openSync(log, "a");
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...prefix, ...args], { env, stdio: ["ignore", fd, fd], windowsHide: true });
    child.on("error", (error) => {
      closeSync(fd);
      reject(error);
    });
    child.on("close", (status) => {
      closeSync(fd);
      const text = readFileSync(log, "utf8");
      resolve({ status, tail: Buffer.from(text).subarray(Math.max(start, Buffer.byteLength(text) - TAIL_CHARS)).toString("utf8") });
    });
  });
}

/**
 * @param run `({ command, args, env, log }) => Promise<{ status, tail }>`; the default spawns `codexCommand`.
 * @returns the exit code: 0 done, 1 bad input or no codex, 2 a limit, 3 out of runs.
 */
export async function runCodexImplement(argv, { run, codexCommand = ["codex"], env = process.env, say = (line) => console.error(line) } = {}) {
  let settings;
  try {
    settings = parseArgs(argv);
  } catch (error) {
    say(`qc codex-implement: ${error.message}\n${USAGE}`);
    return 1;
  }
  const execute = run ?? ((call) => spawnRun(call, codexCommand));
  for (let count = 1; count <= settings.maxRuns; count += 1) {
    if (isDone(settings.progress)) return finish(say, `done after ${count - 1} run(s)`, 0);
    let prompt;
    try {
      prompt = promptFor(settings);
    } catch (error) {
      return finish(say, `cannot read the brief: ${error.message}`, 1);
    }
    const helperOff = HELPER_AGENT_FEATURES.flatMap((feature) => ["-c", feature]);
    const args = ["exec", "-s", "danger-full-access", "-C", settings.worktree, ...helperOff, prompt];
    let result;
    try {
      result = await execute({ command: codexCommand[0], args, env: { ...env, QC_ROLE: "implementer" }, log: settings.log });
    } catch (error) {
      return finish(say, `codex did not run: ${error.message}`, 1);
    }
    say(`qc codex-implement: run ${count} ended with status ${result.status}`);
    if (isDone(settings.progress)) return finish(say, `done after ${count} run(s)`, 0);
    if (reportsLimit(result.tail ?? "", prompt)) return finish(say, "Codex reports a usage or spend limit: dispatch the same brief to a Claude sdd-implementer", 2);
  }
  return finish(say, `out of runs: ${settings.maxRuns} runs and the progress file is not done`, 3);
}

/** A limit line counts only when Codex wrote it, not when the log echoes a line of the prompt. */
function reportsLimit(tail, prompt) {
  const echoed = new Set(prompt.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  return tail.split(/\r?\n/).some((line) => LIMIT.test(line) && !echoed.has(line.trim()));
}

function finish(say, message, code) {
  say(`qc codex-implement: ${message}`);
  return code;
}
