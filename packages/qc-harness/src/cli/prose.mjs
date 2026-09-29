// `qc prose` holds the lines a change adds to the prose style, and no others. Vale reads whole files,
// so a sentence keeps its context, and this module keeps the alerts that fall on an added line.
// Vale is an external binary: outside CI its absence is a note, and in CI it fails the check, as a
// missing `gh` fails `qc pr-check`.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adrLog } from "../config.mjs";
import { globMatcher } from "../glob.mjs";
import { parseAddedLines } from "../prose-lines.mjs";
import { isCi } from "./pr-check.mjs";

const KIT_VALE_CONFIG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../templates/vale/.vale.ini");
const MARKDOWN = /\.mdx?$/i;
const FILES_PER_CALL = 100;
const BUFFER_BYTES = 64 * 1024 * 1024;
const USAGE = "usage: qc prose [--base <ref>] [--pr-body <file>] [--pr-body-event]";

/** Runs one process, and never throws: a missing binary is a failed call like any other. */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: BUFFER_BYTES });
  if (result.error) return { ok: false, missing: result.error.code === "ENOENT", stderr: result.error.message };
  return result.status === 0 ? { ok: true, stdout: result.stdout ?? "" } : { ok: false, stderr: `${result.stderr || result.stdout || ""}` };
}

/** @returns the Vale run of `args` from `cwd`, as `{ok, missing?, stdout?, stderr?}`. */
export const runVale = async (args, { cwd }) => run("vale", args, cwd);

const slashes = (file) => file.replace(/\\/g, "/");

/** @returns the unified diff of the markdown files that `base...HEAD` changed, or null when git cannot read it. */
function readDiff(root, base) {
  const args = ["-c", "core.quotepath=off", "diff", "-U0", "--no-color", "--no-ext-diff", `${base}...HEAD`, "--", "*.md", "*.mdx"];
  const result = run("git", args, root);
  return result.ok ? result.stdout : null;
}

/** @returns the added lines that sit in a linted markdown file: in `prose.paths`, and outside the ADR log and `prose.exempt`. */
export function inScope(config, added) {
  const linted = globMatcher(config.prose.paths);
  const exempt = globMatcher([...adrLog(config), ...config.prose.exempt]);
  return added.filter((line) => MARKDOWN.test(line.path) && linted(line.path) && !exempt(line.path));
}

const valeConfigOf = (config) => {
  const own = path.join(config.root, config.prose.valeConfig);
  return existsSync(own) ? own : KIT_VALE_CONFIG;
};

/**
 * Runs Vale on the files that hold `added`, and keeps the alerts on those lines. An error fails; a
 * warning or a suggestion is advice.
 * @param {object} config
 * @param {{added: {path: string, line: number, text: string, label?: string}[], vale?: typeof runVale, ci?: boolean}} options
 * @returns {Promise<{problems: string[], warnings: string[], notes: string[], checked: number}>}
 */
export async function checkProse(config, { added, vale = runVale, ci = false }) {
  const result = { problems: [], warnings: [], notes: [], checked: added.length };
  if (added.length === 0) return result;

  const files = new Map();
  for (const { path: file, line, label } of added) {
    const entry = files.get(slashes(file)) ?? { file, label: label ?? file, lines: new Set() };
    entry.lines.add(line);
    files.set(slashes(file), entry);
  }
  const failure = ci ? result.problems : result.notes;
  const ini = valeConfigOf(config);
  const names = [...files.values()].map((entry) => entry.file);

  for (let from = 0; from < names.length; from += FILES_PER_CALL) {
    const call = await vale([`--config=${ini}`, "--output=JSON", "--no-exit", ...names.slice(from, from + FILES_PER_CALL)], { cwd: config.root });
    if (!call.ok) {
      const cause = call.missing ? "vale is not installed" : `vale failed: ${(call.stderr ?? "").trim().split("\n")[0]}`;
      failure.push(`${cause}, so the ${added.length} added line(s) were not checked. Install Vale from https://vale.sh to run this check.`);
      return result;
    }
    let report;
    try {
      report = JSON.parse(call.stdout?.trim() || "{}");
    } catch {
      failure.push("vale printed output that is not JSON, so the added lines were not checked");
      return result;
    }
    for (const [file, alerts] of Object.entries(report)) {
      const entry = files.get(slashes(file));
      if (!entry || !Array.isArray(alerts)) continue;
      for (const alert of alerts.filter((each) => entry.lines.has(each.Line))) {
        const text = `${entry.label}:${alert.Line}  ${alert.Check}: ${alert.Message}`;
        (alert.Severity === "error" ? result.problems : result.warnings).push(text);
      }
    }
  }
  return result;
}

function parseArgs(args) {
  const parsed = { base: null, prBodyFile: null, prBodyEvent: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--base" && args[index + 1]) parsed.base = args[++index];
    else if (arg === "--pr-body" && args[index + 1]) parsed.prBodyFile = args[++index];
    else if (arg === "--pr-body-event") parsed.prBodyEvent = true;
    else return null;
  }
  return parsed;
}

/** @returns the pull request body the options name, or null with a note or a problem for why there is none. */
function readBody(root, parsed, env, notes, problems) {
  try {
    if (parsed.prBodyFile) return readFileSync(path.resolve(root, parsed.prBodyFile), "utf8");
    if (!parsed.prBodyEvent) return null;
    if (!env.GITHUB_EVENT_PATH) {
      notes.push("no GITHUB_EVENT_PATH, so there is no pull request body to read");
      return null;
    }
    const pr = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"))?.pull_request;
    if (!pr) notes.push("the event is not a pull request, so there is no body to read");
    return pr ? (pr.body ?? "") : null;
  } catch (error) {
    problems.push(`cannot read the pull request body: ${error.message}`);
    return null;
  }
}

/**
 * @param {object} config
 * @param {string[]} args `--base <ref>`, `--pr-body <file>`, `--pr-body-event`
 * @param {{env?: NodeJS.ProcessEnv, vale?: typeof runVale, base?: string}} [options]
 * @returns {Promise<number>} the exit code
 */
export async function runProse(config, args, { env = process.env, vale = runVale, base } = {}) {
  const parsed = parseArgs(args);
  if (parsed === null) {
    console.error(USAGE);
    return 2;
  }
  const ci = isCi(env);
  const notes = [];
  const problems = [];
  const ref = parsed.base ?? base ?? config.prose.base;

  let added = [];
  const diff = readDiff(config.root, ref);
  if (diff === null) {
    (ci ? problems : notes).push(`git cannot diff ${ref}...HEAD, so the added lines were not read. In CI, check out full history and fetch ${ref}.`);
  } else {
    added = inScope(config, parseAddedLines(diff));
  }

  const scratch = mkdtempSync(path.join(os.tmpdir(), "qc-prose-"));
  try {
    const body = readBody(config.root, parsed, env, notes, problems);
    if (body !== null) {
      const file = path.join(scratch, "pr-body.md");
      const text = body.replace(/\r\n/g, "\n");
      writeFileSync(file, text);
      added.push(...text.split("\n").map((line, index) => ({ path: file, line: index + 1, text: line, label: "PR body" })));
    }
    const result = await checkProse(config, { added, vale, ci });
    problems.push(...result.problems);
    notes.push(...result.notes);
    for (const note of notes) console.log(`NOTE  prose     ${note}`);
    for (const warning of result.warnings) console.log(`WARN  prose     ${warning}`);
    for (const problem of problems) console.error(`FAIL  prose     ${problem}`);
    if (problems.length === 0) console.log(`OK  prose     ${result.checked} added line(s) meet the prose style`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return problems.length > 0 ? 1 : 0;
}
