import { checkPlan } from "./plan-check.mjs";
import { parsePlanDoc, taskFiles } from "./plan-parse.mjs";
import { reviewSettings } from "./workflow-settings.mjs";
import { BLOCKS } from "../gates/eight-blocks.mjs";

export const PLAN_STATUSES = ["draft", "approved", "needs-approval"];
export const REQUIRED_SECTIONS = ["Goal", "Non-goals", "Services", "Catalog", "Change log"];
export const APPROVAL_ROW = /approved by (.+?); services (\d+)/;
export const ADDS_ROW = /adds Task (\d+)/;
export const isLead = (approvedBy) => /^lead\b/i.test(approvedBy ?? "");
export const touchesService = (doc, files) => files.filter((file) => doc.serviceFiles.includes(file.replace(/\\/g, "/")));

export function planSettings(config = {}) {
  const { dir = "docs/plans", fileLines = 500 } = config.plan ?? {};
  if (typeof dir !== "string" || !dir.trim()) throw new TypeError("plan.dir must be a non-empty string");
  if (!Number.isInteger(fileLines) || fileLines < 1) throw new TypeError("plan.fileLines must be a positive whole number");
  return { dir, fileLines };
}

export function planCheckOptions(config) {
  const review = reviewSettings(config.swarm) ?? reviewSettings({ ...config.swarm, dispatch: {} });
  return { maxTaskCalls: review.maxTaskCalls, riskPaths: review.riskPaths, cases: review.cases, fileLines: planSettings(config).fileLines, blocks: BLOCKS };
}

export function checkPlanFile(markdown, options = {}) {
  const { fileLines = 500, blocks = BLOCKS } = options;
  const doc = parsePlanDoc(markdown);
  const problems = checkPlan(markdown, options).map((problem) => ({ ...problem, line: doc.tasks.find((task) => task.number === problem.task)?.line ?? null }));
  const add = (detail, line = null, task = null) => problems.push({ task, line, detail });
  if (doc.issue === null) add("Issue: must name a number");
  if (!PLAN_STATUSES.includes(doc.status)) add("Status: is invalid; Status must be draft, approved or needs-approval", doc.statusLine);
  for (const name of REQUIRED_SECTIONS) if (!doc.sections[name]) add(`missing ## ${name}`);
  if (doc.sections.Services && ((!doc.services.length && !doc.servicesNone) || (doc.services.length && doc.servicesNone !== null))) add("## Services must have service blocks or None: with a reason", doc.sections.Services.line);
  for (const service of doc.services) {
    for (const field of ["interface", "now", "scale"]) if (!service[field] || (field === "interface" && !service.interfaceFile)) add(`${service.name} needs ${field[0].toUpperCase() + field.slice(1)}:${field === "interface" ? " with a file in backticks" : ""}`, service.line);
  }
  if (doc.sections.Catalog && !doc.sections.Catalog.body.some((line) => line.trim())) add("## Catalog must name the parts searched and reused", doc.sections.Catalog.line);
  for (const task of doc.tasks) {
    for (const file of task.files) {
      if (file.lines > fileLines && !task.split) add(`${file.paths.join(", ")} estimate ${file.lines} exceeds ${fileLines}; add Split: with a reason`, file.line, task.number);
      if (file.block && !blocks.includes(file.block)) add(`block \`${file.block}\` is not one of ${blocks.join(", ")}`, file.line, task.number);
    }
  }
  if (doc.status === "approved" && !doc.approvedBy) add("approved needs Approved-by:", doc.statusLine);
  if (isLead(doc.approvedBy) && (!doc.servicesNone || doc.services.length)) add("Approved-by: lead needs None: services", doc.sections.Services?.line);
  const approval = doc.changeLog.findLast((row) => APPROVAL_ROW.test(row.text));
  if (doc.status === "approved" && approval) {
    const count = Number(APPROVAL_ROW.exec(approval.text)[2]);
    if (count !== doc.services.length) add("services changed; set Status: needs-approval and ask the owner", doc.sections.Services?.line);
    for (const row of doc.changeLog.filter((row) => row.line > approval.line)) {
      const number = Number(ADDS_ROW.exec(row.text)?.[1]);
      const task = doc.tasks.find((task) => task.number === number);
      const files = task ? touchesService(doc, taskFiles(task)) : [];
      if (files.length) add(`Task ${number} changes ${files.join(", ")}; set Status: needs-approval and ask the owner`, row.line, number);
    }
  }
  return problems;
}
