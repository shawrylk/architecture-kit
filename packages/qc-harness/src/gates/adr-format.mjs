// An ADR records a decision so a later reader can disagree with it on the evidence. That needs the
// sections nobody writes unprompted: what it cost, and what was considered and rejected. A template
// alone does not produce them -- an empty heading under a filled-in template is the usual outcome,
// so the gate checks that each required section carries prose, not that it exists.

const DEFAULT_SECTIONS = [
  "Prerequisite",
  "Context",
  "Decision",
  "Why this, specifically",
  "What this buys",
  "What this costs",
  "Alternatives considered and not chosen",
  "Related decisions",
];
const MIN_WORDS = 12;
const ID_PATTERN = /^([A-Z]{2,5}-\d{3,4})/;

/** @returns {{heading: string, body: string}[]} every `## ` section, in order. */
export function sections(markdown) {
  const out = [];
  let current = null;
  for (const line of markdown.split("\n")) {
    const heading = /^##\s+(.*?)\s*$/.exec(line);
    if (heading && !line.startsWith("###")) {
      if (current) out.push(current);
      current = { heading: heading[1], body: "" };
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Prose, with the template's own guidance comments and subheadings removed. */
export function wordCount(body) {
  const prose = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^###.*$/gm, " ")
    .replace(/^\s*[|>-].*$/gm, " ");
  return prose.split(/\s+/).filter(Boolean).length;
}

/**
 * @param {{path: string, contents: string}[]} files the ADR documents
 * @param {{sections?: string[], minWords?: number}} [options]
 */
export function checkAdrFormat(files, options = {}) {
  const required = options.sections ?? DEFAULT_SECTIONS;
  const minWords = options.minWords ?? MIN_WORDS;
  if (required.length === 0) throw new Error("adr.sections must name at least one required section");

  const problems = [];
  for (const { path, contents } of files) {
    const title = contents.split("\n").find((line) => line.startsWith("# ")) ?? "";
    const id = ID_PATTERN.exec(title.replace(/^#\s+/, ""));
    if (!id) {
      problems.push({ path, rule: "adr-title", detail: "the title must open with the decision id, as `# ADR-0031 — <claim>`." });
    }
    const present = sections(contents);
    const byHeading = new Map(present.map((section) => [section.heading, section.body]));

    for (const heading of required) {
      if (!byHeading.has(heading)) {
        problems.push({ path, rule: "adr-section-missing", detail: `no "## ${heading}" section.` });
        continue;
      }
      const words = wordCount(byHeading.get(heading));
      if (words < minWords) {
        problems.push({
          path,
          rule: "adr-section-empty",
          detail: `"${heading}" carries ${words} word(s). A heading left empty records nothing — say what it cost, or say there was no cost and why.`,
        });
      }
    }
  }
  return problems;
}

/** @returns the ids an ADR relates to, for the citations gate to resolve. */
export function relatedIds(contents) {
  const related = sections(contents).find((section) => section.heading === "Related decisions");
  if (!related) return [];
  return [...new Set(related.body.match(/\b[A-Z]{2,5}-\d{3,4}\b/g) ?? [])];
}
