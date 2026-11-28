import { readFileSync } from "node:fs";
import path from "node:path";
import { parsePlanDoc, taskDone, taskFiles } from "./plan-parse.mjs";
import { briefPlanOf } from "./plan-gate.mjs";
import { filePlanStore } from "./plan-store.mjs";

export const lineCount = (text) => text === "" ? 0 : text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
const normalize = (file) => path.posix.normalize(file.replace(/\\/g, "/"));

export function planReviewNotes({ ref, doc, task: number, files, before, after, fileLines }) {
  const task = doc.tasks.find((task) => task.number === number);
  if (!task) throw new Error(`${ref}: has no Task ${number}`);
  const allowed = new Set([ref, ...taskFiles(task), ...doc.tasks.filter(taskDone).flatMap(taskFiles)].map(normalize));
  const drift = files.filter((file) => !allowed.has(normalize(file)));
  const notes = [];
  if (drift.length) notes.push(`Plan drift: files outside Task ${number} of \`${ref}\`: ${drift.map((file) => `\`${file}\``).join(", ")}. Report each as a finding unless the task covers it.`);
  if (!task.split) for (const file of files) {
    const oldSize = before.get(file) ?? 0, newSize = after.get(file) ?? 0;
    if (oldSize <= fileLines && newSize > fileLines) notes.push(`Plan size: \`${file}\` grew past plan.fileLines (${fileLines}): ${oldSize} to ${newSize} lines.`);
  }
  notes.push(`Plan check: compare the diff with Task ${number}, ## Services and ## Catalog of \`${ref}\`. Report any drift as a finding.`);
  return notes;
}

export async function planReviewText({ source, worktree, base, files, git, fileLines }) {
  const plan = briefPlanOf(source);
  if (!plan) return "";
  const doc = parsePlanDoc(filePlanStore(worktree).read(plan.plan));
  const before = new Map(), after = new Map();
  for (const file of files) {
    try { before.set(file, lineCount((await git(worktree, "show", `${base}:${file}`)).stdout)); }
    catch { before.set(file, 0); }
    try { after.set(file, lineCount(readFileSync(path.resolve(worktree, file), "utf8"))); }
    catch (error) { if (error.code !== "ENOENT") throw error; after.set(file, 0); }
  }
  const ref = path.relative(worktree, path.resolve(worktree, plan.plan.replace(/\\/g, "/"))).replace(/\\/g, "/");
  return planReviewNotes({ ref, doc, task: plan.task, files, before, after, fileLines }).join("\n");
}
