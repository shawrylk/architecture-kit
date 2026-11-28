import { filesOf } from "./plan-check.mjs";

/** @typedef {{kind: string, paths: string[], block: string|null, lines: number|null, line: number}} PlanFileLine */
/** @typedef {{line: number, done: boolean, title: string}} PlanStep */
/** @typedef {{number: number, title: string, line: number, endLine: number, files: PlanFileLine[], steps: PlanStep[], split: string|null}} PlanTask */
/** @typedef {{name: string, line: number, interface: string|null, interfaceFile: string|null, now: string|null, scale: string|null}} PlanService */
/** @typedef {{issue: number|null, status: string|null, statusLine: number|null, approvedBy: string|null, sections: Object, services: PlanService[], servicesNone: string|null, serviceFiles: string[], changeLog: {line: number, text: string}[], tasks: PlanTask[]}} PlanDoc */

// Keep line positions while removing comments and fenced code.
export function planLines(markdown) {
  let fence = null;
  return markdown.replace(/<!--[\s\S]*?-->/g, (text) => text.replace(/[^\r\n]/g, " "))
    .split(/\r?\n/).map((line) => {
      const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
        return "";
      }
      if (marker) { fence = marker; return ""; }
      return line;
    });
}

const sectionNames = ["Goal", "Non-goals", "Services", "Catalog", "Change log"];
const spans = (line) => [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]).filter((value) => /[/\\]|\.[\w]+$/.test(value)).map((value) => value.replace(/\\/g, "/"));
const clean = (value) => value.replace(/`/g, "").trim();

/** @returns {PlanDoc} */
export function parsePlanDoc(markdown) {
  const lines = planLines(markdown);
  const doc = { issue: null, status: null, statusLine: null, approvedBy: null, sections: {}, services: [], servicesNone: null, serviceFiles: [], changeLog: [], tasks: [] };
  let header = true, section = null, service = null, task = null;
  const seen = new Set();
  lines.forEach((line, index) => {
    const number = index + 1;
    if (/^#{1,3}[ \t]/.test(line) && task) { task.endLine = index; task = null; }
    if (/^#{1,2}[ \t]/.test(line)) { section = null; service = null; }
    const heading = /^##[ \t]+(.+?)\s*$/.exec(line);
    if (heading) {
      header = false;
      section = sectionNames.find((name) => name.toLowerCase() === heading[1].toLowerCase()) ?? null;
      if (section) doc.sections[section] = { line: number, body: [] };
      return;
    }
    if (header) {
      const field = /^(Issue|Status|Approved-by):[ \t]*(.*)$/.exec(line);
      if (field && !seen.has(field[1])) {
        seen.add(field[1]);
        const value = clean(field[2]);
        if (field[1] === "Issue") doc.issue = /^#?\d+$/.test(value) ? Number(value.replace(/^#/, "")) : null;
        if (field[1] === "Status") { doc.status = value; doc.statusLine = number; }
        if (field[1] === "Approved-by") doc.approvedBy = value && value.toLowerCase() !== "none" ? value : null;
      }
    }
    if (section) doc.sections[section].body.push(line);
    if (section === "Services") {
      doc.serviceFiles.push(...spans(line));
      const name = /^###[ \t]+(.+)$/.exec(line)?.[1];
      if (name) { service = { name, line: number, interface: null, interfaceFile: null, now: null, scale: null }; doc.services.push(service); }
      const none = /^(?:[ \t]*-[ \t]+)?None:[ \t]*(.*)/i.exec(line);
      if (none) doc.servicesNone = none[1].trim();
      const field = /^(?:[ \t]*-[ \t]+)?(Interface|Now|Scale):[ \t]*(.*)/i.exec(line);
      if (field && service) {
        service[field[1].toLowerCase()] = field[2].trim();
        if (field[1].toLowerCase() === "interface") service.interfaceFile = spans(field[2])[0] ?? null;
      }
    }
    if (section === "Change log") {
      const row = /^[ \t]*-[ \t]+(.+)/.exec(line);
      if (row) doc.changeLog.push({ line: number, text: row[1] });
    }
    const title = /^###[ \t]+Task[ \t]+(\d+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (title) {
      task = { number: Number(title[1]), title: title[2].trim(), line: number, endLine: lines.length, files: [], steps: [], split: null };
      doc.tasks.push(task);
      return;
    }
    if (!task) return;
    const file = /^[ \t]*[-*][ \t]+(Create|Modify|Test|Delete|Rename):[ \t]*\S/i.exec(line);
    if (file) task.files.push({ kind: file[1][0].toUpperCase() + file[1].slice(1).toLowerCase(), paths: filesOf(line), block: /\(block:[ \t]*([\w-]+)\)/.exec(line)?.[1] ?? null, lines: /\(~([\d,]+)[ \t]*lines?\)/.test(line) ? Number(RegExp.$1.replace(/,/g, "")) : null, line: number });
    const step = /^[ \t]*[-*][ \t]+\[([ xX])\][ \t]+\*\*(.+?)\*\*/.exec(line);
    if (step) task.steps.push({ line: number, done: step[1] !== " ", title: step[2] });
    const split = /^[ \t]*Split:[ \t]*(.+)/.exec(line);
    if (split) task.split = split[1].trim();
  });
  doc.serviceFiles = [...new Set(doc.serviceFiles)];
  return doc;
}

export const taskDone = (task) => task.steps.length > 0 && task.steps.every((step) => step.done);
export const nextTask = (doc) => doc.tasks.find((task) => !taskDone(task)) ?? null;
export const taskFiles = (task) => [...new Set(task.files.flatMap((file) => file.paths))];
