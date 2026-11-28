import { execFileSync } from "node:child_process";
import path from "node:path";
import { parsePlanDoc, taskDone, taskFiles } from "./plan-parse.mjs";
import { checkPlanFile } from "./plan-file-check.mjs";

export function briefPlanOf(brief) {
  const plan = /^Plan:[ \t]*([^\r\n]*)/m.exec(brief);
  if (!plan) return null;
  const value = (text) => text.trim().replace(/^`(.*)`$/, "$1");
  const task = value(/^Task:[ \t]*([^\r\n]*)/m.exec(brief)?.[1] ?? "");
  return { plan: value(plan[1]), task: /^\d+$/.test(task) && Number(task) > 0 ? Number(task) : null };
}
export const isFixRound = (brief) => /^Proof:[ \t]*\S/m.test(brief);

export function pathInTask(entry, files) {
  const normalize = (file) => path.posix.normalize(file.replace(/\\/g, "/")).replace(/\/$/, "");
  const owned = normalize(entry);
  return owned === "." || files.some((file) => normalize(file) === owned || normalize(file).startsWith(`${owned}/`));
}

export function planStartRefusal({ brief, paths, store, options }) {
  if (isFixRound(brief)) return null;
  const ref = briefPlanOf(brief);
  if (!ref) return "Plan: is required for implement when codex.requirePlan is true; write one with `qc plan new <issue> <topic>`";
  if (!ref.task) return "Task: <N> is required with Plan:";
  let text;
  try { text = store.read(ref.plan); }
  catch (error) { return `Plan: ${ref.plan} cannot be read: ${error.message}`; }
  const problem = checkPlanFile(text, options)[0];
  if (problem) return `${ref.plan}:${problem.line ?? 1}: ${problem.detail}; run \`qc plan check ${ref.plan}\``;
  const doc = parsePlanDoc(text);
  if (doc.status !== "approved") return `${ref.plan}:${doc.statusLine}: Status is ${doc.status}; the owner runs \`qc plan approve ${ref.plan} --by <name>\``;
  const task = doc.tasks.find((task) => task.number === ref.task);
  if (!task) return `${ref.plan}: has no Task ${ref.task}; fix Task:`;
  if (taskDone(task)) return `${ref.plan}:${task.line}: Task ${ref.task} is done; run \`qc plan status ${ref.plan}\` for the next open task`;
  const outside = paths.find((entry) => !pathInTask(entry, taskFiles(task)));
  if (outside) return `Paths: \`${outside}\` is not a file of Task ${ref.task} in ${ref.plan}; run \`qc plan revalidate ${ref.plan} <issue> --adds "<title>" --files ${outside}\` or fix Paths:`;
  return null;
}

export function planFileTouched({ worktree, base, plan }) {
  const file = path.relative(worktree, path.resolve(worktree, plan.replace(/\\/g, "/")));
  if (file === ".." || file.startsWith(`..${path.sep}`) || path.isAbsolute(file)) throw new Error(`Plan: ${plan} is outside ${worktree}`);
  const git = (...args) => execFileSync("git", ["--literal-pathspecs", ...args], { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return Boolean(git("status", "--porcelain", "--", file) || (base && git("diff", "--name-only", base, "HEAD", "--", file)));
}
