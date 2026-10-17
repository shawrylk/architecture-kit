// `qc retry-failed`: a run that fails only in a few test files reruns those files once before it fails.
// A load flake passes on the rerun; a real failure fails twice, and any other failure is never rerun.

import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { commandLine, runInShell, splitAtDashes } from "./child-run.mjs";

export const USAGE = `qc retry-failed — rerun only the failed test files, once, before a run fails

  qc retry-failed --report <json> --rerun "<command>" [--max-files <n>] -- <command...>
      run <command>. When it fails and <json>, the Jest or Vitest JSON report the run wrote, names at
      most --max-files failed test files (5 by default), run "<rerun> <files>" once and exit with its
      code. Any other failure exits with the first code. The report is removed before the run.`;

export const DEFAULT_MAX_FILES = 5;

const readText = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** The failed test files of a Jest or Vitest JSON report, relative to `root`, or null when the text is no such report. */
export function failedFiles(text, root) {
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    return null;
  }
  if (!report || !Array.isArray(report.testResults)) return null;
  return report.testResults
    .filter((result) => result?.status === "failed" && typeof result.name === "string")
    .map((result) => (path.isAbsolute(result.name) ? path.relative(root, result.name) : result.name).split(path.sep).join("/"));
}

/** `qc retry-failed`. @returns the exit code */
export async function runRetryFailed(argv, deps = {}) {
  const {
    run = runInShell,
    read = readText,
    remove = (file) => rmSync(file, { force: true }),
    cwd = process.cwd(),
    env = process.env,
    say = (line) => console.error(line),
  } = deps;
  const { flags, command } = splitAtDashes(argv);
  let values;
  let maxFiles;
  try {
    ({ values } = parseArgs({ args: flags, options: { report: { type: "string" }, rerun: { type: "string" }, "max-files": { type: "string" } }, strict: true }));
    if (!values.report || !values.rerun || command.length === 0) throw new Error("--report, --rerun, and a command after -- are required");
    maxFiles = Number(values["max-files"] ?? DEFAULT_MAX_FILES);
    if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new Error(`--max-files must be a positive integer, got ${values["max-files"]}`);
  } catch (error) {
    say(`qc retry-failed: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  const reportFile = path.resolve(cwd, values.report);
  remove(reportFile);
  const first = await run(commandLine(command), env, cwd);
  if (first === 0) return 0;
  const text = read(reportFile);
  const files = text === null ? null : failedFiles(text, cwd);
  if (files === null || files.length === 0) {
    say(`qc retry-failed: the run failed with no failed test file in ${values.report}, so nothing is rerun`);
    return first;
  }
  if (files.length > maxFiles) {
    say(`qc retry-failed: ${files.length} test files failed, over --max-files ${maxFiles}, so nothing is rerun`);
    return first;
  }
  say(`qc retry-failed: ${files.length} test file(s) failed; rerunning them once: ${files.join(" ")}`);
  const second = await run(`${values.rerun} ${commandLine(files)}`, env, cwd);
  if (second === 0) say(`qc retry-failed: the rerun passed, so these files are flaky: ${files.join(" ")}`);
  return second;
}
