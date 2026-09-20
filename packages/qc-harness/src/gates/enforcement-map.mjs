// QC-007: a rule that cannot name its check is deleted or converted into one. The map
// in docs/enforcement.md is what carries that, and nothing has been watching the map.
//
// A stale row is the quiet failure here: a rule renamed in code, still listed under its
// old name, reads as enforced by something that no longer exists. Only the checks this
// kit owns are resolved — a row naming a third-party rule or a shell command is listed
// and left alone, because this gate cannot know what those are.

const RULE = /`qc\/([a-z0-9-]+)`/g;
const GATE = /`qc check`\s*\(([a-z0-9-]+)\)/g;

function found(markdown, pattern) {
  pattern.lastIndex = 0;
  const names = new Set();
  let match = pattern.exec(markdown);
  while (match !== null) {
    names.add(match[1]);
    match = pattern.exec(markdown);
  }
  return names;
}

/**
 * @param {string} markdown        docs/enforcement.md
 * @param {string[]} rules         rule names the kit provides
 * @param {string[]} gates         gate names `qc check` runs
 * @param {{requireEveryCheckListed?: boolean}} [options]
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkEnforcementMap(markdown, rules, gates, options = {}) {
  const label = "docs/enforcement.md";
  const problems = [];

  const citedRules = found(markdown, RULE);
  const citedGates = found(markdown, GATE);

  for (const name of [...citedRules].sort()) {
    if (!rules.includes(name)) {
      problems.push({ path: label, rule: "unknown-check", detail: `qc/${name} is listed but no such rule exists` });
    }
  }
  for (const name of [...citedGates].sort()) {
    if (!gates.includes(name)) {
      problems.push({ path: label, rule: "unknown-check", detail: `qc check (${name}) is listed but no such gate exists` });
    }
  }

  // The other direction: a check nobody wrote down is a rule nobody can find.
  if (options.requireEveryCheckListed !== false) {
    for (const name of rules) {
      if (!citedRules.has(name)) {
        problems.push({ path: label, rule: "unlisted-check", detail: `qc/${name} enforces something the map does not state` });
      }
    }
    for (const name of gates) {
      if (!citedGates.has(name)) {
        problems.push({ path: label, rule: "unlisted-check", detail: `qc check (${name}) enforces something the map does not state` });
      }
    }
  }
  return problems;
}
