// The note an agent writes when it stops mid-task, and the check a hook runs on it. A fresh agent resumes
// from the note, so the note names the brief, the place, the head, what is done, and what comes next.

import { readFileSync } from "node:fs";
import path from "node:path";
import { nativePath } from "./workflow-place.mjs";

export const HANDOFF_LINE = /^[ \t]*HANDOFF:[ \t]*(\S.*?)[ \t]*$/m;
const QUOTES = /^["'`]|["'`]$/g;
const FIELDS = ["Brief", "Worktree", "Branch", "Head"];
const SECTIONS = [["Done", "done"], ["Left", "left"], ["Next step", "next"]];
const SHA = /^[0-9a-fA-F]{7,40}$/;
const fieldLine = (name) => new RegExp(`^[ \\t]*${name}:[ \\t]*(\\S.*?)[ \\t]*$`, "im");

/** The path on a report's or a prompt's `HANDOFF:` line, without quotes, or null. */
export function handoffPathOf(text) {
  const match = HANDOFF_LINE.exec(String(text ?? ""));
  return match ? match[1].replace(QUOTES, "") : null;
}

/** The absolute path a spelled note path names, with a Git Bash drive path in Windows spelling. */
export const resolveHandoff = (spelled, cwd) => path.resolve(cwd, nativePath(spelled));

/** The lines under each `## <name>` heading, blank lines dropped. */
function sectionsOf(markdown) {
  const sections = {};
  let name = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (heading) {
      name = heading[1];
      sections[name] = [];
    } else if (name !== null && line.trim() !== "") {
      sections[name].push(line);
    }
  }
  return sections;
}

/** The note's four lines and its three sections; a missing one is null. */
export function parseHandoff(markdown) {
  const note = Object.fromEntries(FIELDS.map((name) => [name.toLowerCase(), fieldLine(name).exec(markdown)?.[1] ?? null]));
  const sections = sectionsOf(markdown);
  for (const [heading, key] of SECTIONS) note[key] = sections[heading] ?? null;
  return note;
}

/** @returns each thing the note lacks, as a phrase; empty when the note is complete. */
export function handoffProblems(markdown) {
  const note = parseHandoff(markdown);
  const problems = FIELDS.filter((name) => !note[name.toLowerCase()]).map((name) => `a line \`${name}: <value>\``);
  if (note.head && !SHA.test(note.head)) problems.push(`a \`Head:\` sha of 7 to 40 hex digits, not "${note.head}"`);
  for (const [heading, key] of SECTIONS) {
    if (!note[key] || note[key].length === 0) problems.push(`a \`## ${heading}\` section with at least one line`);
  }
  return problems;
}

/** Reads the note a `HANDOFF:` line names. `missing` is the read error's code when the file does not read. */
export function checkHandoffFile(spelled, cwd) {
  const file = resolveHandoff(spelled, cwd);
  let markdown;
  try {
    markdown = readFileSync(file, "utf8");
  } catch (error) {
    return { file, missing: error.code ?? error.message, problems: [] };
  }
  return { file, missing: null, problems: handoffProblems(markdown) };
}
