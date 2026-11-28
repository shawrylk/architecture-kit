import { parsePlanDoc, planLines } from "./plan-parse.mjs";

const ending = (text) => /\r\n/.test(text) ? "\r\n" : "\n";
function setHeader(markdown, name, value) {
  const visible = planLines(markdown);
  const end = visible.findIndex((line) => /^##[ \t]/.test(line));
  const index = visible.findIndex((line, index) => (end < 0 || index < end) && line.startsWith(`${name}:`));
  if (index < 0) throw new Error(`the plan has no ${name}: line`);
  const lines = markdown.split(/\r?\n/);
  lines[index] = `${name}: ${value}`;
  return lines.join(ending(markdown));
}
export const setStatus = (markdown, status) => setHeader(markdown, "Status", status);
export const setApprovedBy = (markdown, value) => setHeader(markdown, "Approved-by", value);

export function appendChangeLog(markdown, row) {
  const doc = parsePlanDoc(markdown);
  const section = doc.sections["Change log"];
  if (!section) throw new Error("the plan has no ## Change log section");
  const lines = markdown.split(/\r?\n/);
  let index = section.line + section.body.length;
  while (index > section.line && !lines[index - 1].trim()) index--;
  lines.splice(index, 0, `- ${row}`);
  return lines.join(ending(markdown));
}

export function appendTaskStub(markdown, { number, title, files, note }) {
  const stub = [`### Task ${number}: ${title}`, "", note, "", "**Files:**", ...files.map((file) => `- Modify: \`${file}\``), "", "- [ ] **Step 1: Write the failing test**", "- [ ] **Step 2: Implement the change**", "- [ ] **Step 3: Run the test and see it pass**", "- [ ] **Step 4: Commit**", ""];
  return markdown.trimEnd() + ending(markdown) + ending(markdown) + stub.join(ending(markdown));
}

export function tickTask(markdown, number) {
  const task = parsePlanDoc(markdown).tasks.find((task) => task.number === number);
  if (!task) throw new Error(`the plan has no Task ${number}`);
  const lines = markdown.split(/\r?\n/);
  for (const step of task.steps) lines[step.line - 1] = lines[step.line - 1].replace(/\[[ xX]\]/, "[x]");
  return lines.join(ending(markdown));
}
