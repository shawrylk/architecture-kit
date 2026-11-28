import { readFileSync } from "node:fs";
import path from "node:path";
import { parsePlanDoc, nextTask, taskDone } from "./plan-parse.mjs";
import { checkPlanFile, planCheckOptions, planSettings, touchesService } from "./plan-file-check.mjs";
import { filePlanStore } from "./plan-store.mjs";
import { setStatus, setApprovedBy, appendChangeLog, appendTaskStub, tickTask } from "./plan-edit.mjs";

export function renderTemplate({ issue, topic, uiCatalog }) {
  const values = { issue, topic, catalog: uiCatalog ? "Search the UI catalog first: `qc ui find <words>`." : "Search the code first: `rg -n <name>`." };
  return readFileSync(new URL("../../templates/plan.md", import.meta.url), "utf8").replace(/{{(issue|topic|catalog)}}/g, (_, key) => values[key]);
}

export function markTaskDone(store, ref, number) {
  const before = store.read(ref);
  const after = tickTask(before, number);
  if (after === before) return false;
  store.write(ref, after);
  return true;
}

function usage(detail) { throw Object.assign(new Error(detail), { usage: true }); }
const positiveTask = (value) => /^\d+$/.test(value ?? "") && Number(value) > 0;
const singleLine = (value) => typeof value === "string" && value.trim() && !/[\r\n]/.test(value);
function flags(args, allowed) {
  const values = {};
  while (args.length) {
    const name = args.shift();
    if (!Object.hasOwn(allowed, name) || Object.hasOwn(values, name)) usage(`invalid option ${name}`);
    values[name] = allowed[name] ? args.shift() : true;
    if (allowed[name] && (!singleLine(values[name]) || values[name].startsWith("--"))) usage(`${name} needs a value`);
  }
  return values;
}

export function runPlan(config, argv, deps = {}) {
  const out = deps.out ?? console.log, err = deps.err ?? console.error;
  try {
    const settings = planSettings(config);
    const store = deps.store ?? filePlanStore(config.root ?? process.cwd(), settings.dir);
    const options = planCheckOptions(config);
    const [command, file, ...args] = argv;
    const date = () => new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10);
    const refOf = (file) => path.relative(config.root ?? process.cwd(), path.resolve(config.root ?? process.cwd(), file.replace(/\\/g, "/"))).replace(/\\/g, "/");
    const report = (text, ref) => {
      const problems = checkPlanFile(text, options);
      for (const problem of problems.slice(0, 3)) err(`FAIL  plan  ${ref}:${problem.line ?? 1}: ${problem.detail}`);
      return problems.length > 0;
    };
    if (command === "new") {
      if (!/^#?\d+$/.test(file ?? "") || args.length !== 1 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args[0])) usage("new <issue> <topic>");
      const issue = Number(file.replace(/^#/, "")), topic = args[0];
      const existing = store.list().find((ref) => path.posix.basename(ref).startsWith(`${issue}-`));
      if (existing) throw new Error(`issue #${issue} already has ${existing}`);
      const ref = refOf(path.join(settings.dir, `${issue}-${topic}.md`));
      store.write(ref, renderTemplate({ issue, topic, uiCatalog: config.gates?.["ui-catalog"] === true }));
      out(ref);
      return 0;
    }
    if (!["check", "status", "revalidate", "approve", "done"].includes(command) || !singleLine(file)) usage("new|check|status|revalidate|approve|done needs its arguments");
    if (["check", "status"].includes(command) && args.length) usage(`${command} <file>`);
    if (command === "done" && (args.length !== 1 || !positiveTask(args[0]))) usage("done <file> <N>");
    let parsedFlags;
    if (command === "approve") {
      parsedFlags = flags([...args], { "--by": true });
      if (!parsedFlags["--by"]) usage("approve <file> --by <name>");
    }
    if (command === "revalidate") {
      if (!singleLine(args[0]) || args[0].startsWith("--")) usage("revalidate needs a reference");
      parsedFlags = flags(args.slice(1), { "--fits": true, "--adds": true, "--files": true, "--new-plan": false, "--out": true });
      if (["--fits", "--adds", "--new-plan", "--out"].filter((mode) => Object.hasOwn(parsedFlags, mode)).length !== 1) usage("revalidate needs exactly one mode");
      if (parsedFlags["--fits"] && !positiveTask(parsedFlags["--fits"])) usage("--fits needs a task number");
      if (parsedFlags["--files"] && !parsedFlags["--adds"]) usage("--files needs --adds");
      if (parsedFlags["--adds"] && !parsedFlags["--files"]) usage("--adds needs --files <a,b>");
    }
    const ref = refOf(file);
    if (command === "done") { markTaskDone(store, ref, Number(args[0])); out(`Task ${args[0]} done`); return 0; }
    const text = store.read(ref), doc = parsePlanDoc(text);
    if (command === "check") return report(text, ref) ? 1 : 0;
    if (command === "status") {
      const next = nextTask(doc);
      out(`${ref}: status ${doc.status}, next ${next ? `Task ${next.number}` : "none"}`);
      for (const task of doc.tasks) out(`Task ${task.number} ${taskDone(task) ? "done" : task === next ? "next" : "open"}  ${task.title}`);
      out(`Last change: ${doc.changeLog.at(-1)?.text ?? "none"}`);
      return 0;
    }
    if (command === "approve") {
      const name = parsedFlags["--by"].trim();
      const updated = appendChangeLog(setApprovedBy(setStatus(text, "approved"), `${name} ${date()}`), `${date()} approval: approved by ${name}; services ${doc.services.length}`);
      if (report(updated, ref)) return 1;
      store.write(ref, updated);
      return 0;
    }
    const f = parsedFlags;
    let updated = text, row;
    const prefix = `${date()} ${args[0]}:`;
    if (f["--fits"]) {
      if (!doc.tasks.some((task) => task.number === Number(f["--fits"]))) throw new Error(`the plan has no Task ${f["--fits"]}`);
      row = `${prefix} fits Task ${f["--fits"]}`;
    } else if (f["--adds"]) {
      const files = f["--files"].split(",").map((file) => file.trim().replace(/\\/g, "/"));
      if (files.some((file) => !file || /[`\r\n]/.test(file))) usage("--files needs paths separated by commas");
      const number = Math.max(0, ...doc.tasks.map((task) => task.number)) + 1;
      row = `${prefix} adds Task ${number} "${f["--adds"]}"; files ${files.join(", ")}`;
      updated = appendTaskStub(text, { number, title: f["--adds"], files, note: `Added by \`qc plan revalidate\` for ${args[0]}.` });
      if (touchesService(doc, files).length) { row += "; needs approval"; updated = setStatus(updated, "needs-approval"); }
    } else if (f["--new-plan"]) row = `${prefix} needs a new plan`;
    else row = `${prefix} out of scope: ${f["--out"]}`;
    store.write(ref, appendChangeLog(updated, row));
    return 0;
  } catch (error) {
    err(`qc plan: ${error.message}`);
    return error.usage ? 2 : 1;
  }
}
