// A cited id is defined here, or it is a pointer to something a reader cannot open. QC-007.
const DEFAULT_PREFIXES = ["ADR", "QC"];
const DEFAULT_REQUIREMENT = "REQ-[A-Z]{3}-\\d{3}";

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function citationSource(prefixes) {
  return prefixes.map((prefix) => `${escape(prefix)}-\\d{3,4}`).join("|");
}

/**
 * What counts as a citation, so a tool that rewrites one matches what this gate reads.
 * @param {string[]} [prefixes]
 * @returns {RegExp} global, so `matchAll` and `replace` both work off it
 */
export function citationPattern(prefixes) {
  return new RegExp(`\\b(?:${citationSource(prefixes ?? DEFAULT_PREFIXES)})\\b`, "g");
}

/** Ids a file may cite, harvested from the decision log's table rows. */
export function definedIds(decisionsMarkdown, options = {}) {
  const row = new RegExp(`^\\|\\s*(${citationSource(options.prefixes ?? DEFAULT_PREFIXES)})\\s*\\|`);
  const ids = new Set();
  for (const line of decisionsMarkdown.split("\n")) {
    const cell = row.exec(line);
    if (cell) ids.add(cell[1]);
  }
  return ids;
}

/**
 * @param {{path: string, contents: string}[]} files
 * @param {Set<string>} decisions
 * @param {Set<string>} requirements
 * @param {{prefixes?: string[], requirement?: string}} [options]
 */
export function checkCitations(files, decisions, requirements, options = {}) {
  const citation = new RegExp(`\\b(?:${citationSource(options.prefixes ?? DEFAULT_PREFIXES)})\\b`, "g");
  const requirementId = new RegExp(`\\b(?:${options.requirement ?? DEFAULT_REQUIREMENT})\\b`, "g");
  const problems = [];
  for (const { path, contents } of files) {
    for (const id of new Set(contents.match(citation) ?? [])) {
      if (!decisions.has(id)) {
        problems.push({ path, rule: "undefined-decision", detail: id });
      }
    }
    for (const id of new Set(contents.match(requirementId) ?? [])) {
      if (!requirements.has(id)) {
        problems.push({ path, rule: "undefined-requirement", detail: id });
      }
    }
  }
  return problems;
}

/**
 * A reference reaching outside this repository is a broken repository.
 * @param {{path: string, contents: string}[]} files
 * @param {string[]} [foreign] regular expression sources, each optionally `/pattern/flags`
 */
export function checkSelfContained(files, foreign = []) {
  const patterns = foreign.map((entry) => {
    const delimited = /^\/(.*)\/([a-z]*)$/.exec(entry);
    return delimited ? new RegExp(delimited[1], delimited[2]) : new RegExp(entry);
  });
  const problems = [];
  for (const { path, contents } of files) {
    for (const pattern of patterns) {
      if (pattern.test(contents)) {
        problems.push({ path, rule: "foreign-reference", detail: String(pattern) });
      }
    }
  }
  return problems;
}

const DEFAULT_DOCS_ROOT = "docs";

/** A cited doc that does not exist is a pointer a reader cannot follow. */
export function checkDocPaths(files, existingDocs, options = {}) {
  const docPath = new RegExp(`\\b${escape(options.docsRoot ?? DEFAULT_DOCS_ROOT)}\\/[a-z0-9-]+\\.md\\b`, "g");
  const problems = [];
  for (const { path, contents } of files) {
    for (const doc of new Set(contents.match(docPath) ?? [])) {
      if (!existingDocs.has(doc)) {
        problems.push({ path, rule: "missing-doc", detail: doc });
      }
    }
  }
  return problems;
}
