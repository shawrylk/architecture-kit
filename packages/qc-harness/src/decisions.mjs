// Renumbering a decision means rewriting every citation of it, or leaving a dangling pointer.

import { citationPattern } from "./gates/citations.mjs";

const NOISE = new Set(
  ("a an and are as at be by for from has have in is it its never no not of on one only or so than that the their then there these they this to what when which who with without every each any all".split(" ")),
);

/** The register as rows, so an audit can read what a decision says and not merely that it exists. */
export function parseRegister(markdown, prefixes) {
  const id = citationPattern(prefixes);
  const rows = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 3) continue;
    const found = cells[0].match(id);
    if (found?.length === 1 && found[0] === cells[0]) {
      rows.push({ id: cells[0], decision: cells[1], rule: cells[2] });
    }
  }
  return rows;
}

/** Distinctive words only. A backticked identifier is kept: in a rule it is usually the subject. */
export function terms(text) {
  const words = text.toLowerCase().replaceAll("`", " ").match(/[a-z][a-z-]{2,}/g);
  return new Set((words ?? []).filter((word) => !NOISE.has(word)));
}

export function similarity(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const term of left) if (right.has(term)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

export function sequences(ids) {
  const bySeries = new Map();
  for (const id of ids) {
    const at = id.lastIndexOf("-");
    const number = id.slice(at + 1);
    const series = bySeries.get(id.slice(0, at)) ?? [];
    series.push({ id, number: Number(number), width: number.length });
    bySeries.set(id.slice(0, at), series);
  }
  for (const series of bySeries.values()) series.sort((a, b) => a.number - b.number);
  return bySeries;
}

/** Renumbered from one in the order the rows stand, so which decision came first survives. */
export function squashPlan(defined) {
  const plan = new Map();
  for (const [prefix, series] of sequences(defined)) {
    // One width for the series: a squash that left 001 beside 0002 would close gaps and open a seam.
    const width = Math.max(...series.map((entry) => entry.width));
    series.forEach((entry, index) => {
      const next = prefix + "-" + String(index + 1).padStart(width, "0");
      if (next !== entry.id) plan.set(entry.id, next);
    });
  }
  return plan;
}

export function renamePlan(spec) {
  const plan = new Map();
  for (const pair of spec.split(",")) {
    const [from, to] = pair.split("=").map((half) => half.trim());
    if (!from || !to) throw new Error(`rename wants OLD=NEW, got "${pair}"`);
    plan.set(from, to);
  }
  return plan;
}

/** A plan is refused whole rather than applied in part. */
export function planProblems(plan, defined) {
  const problems = [];
  const landing = new Map();
  for (const [from, to] of plan) {
    if (!defined.has(from)) problems.push(`${from} is not a decision this repository defines`);
    if (defined.has(to) && !plan.has(to)) {
      problems.push(`${to} is already taken by a decision this plan does not move`);
    }
    const other = landing.get(to);
    if (other !== undefined) problems.push(`${other} and ${from} would both become ${to}`);
    landing.set(to, from);
  }
  return problems;
}

/** One pass over one alternation: every position is visited once, so a swap cannot collapse. */
export function rewrite(contents, plan) {
  if (plan.size === 0) return contents;
  const alternation = [...plan.keys()].map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return contents.replaceAll(new RegExp(`\\b(?:${alternation})\\b`, "g"), (id) => plan.get(id) ?? id);
}

/** A file whose bytes are its identity: rewriting a citation inside one invalidates the hash that names it. */
export function isImmutable(file, patterns) {
  return patterns.some((source) => new RegExp(source).test(file));
}

/** `ADR-0001` is a lookup; `ADR-0001=ADR-0002` merely contains one and is not. */
export function isBareId(text, prefixes) {
  const found = text.match(citationPattern(prefixes));
  return found?.length === 1 && found[0] === text;
}

export function citationsIn(contents, prefixes) {
  const pattern = citationPattern(prefixes);
  const found = [];
  for (const [index, text] of contents.split("\n").entries()) {
    for (const id of text.match(pattern) ?? []) found.push({ id, line: index + 1, text: text.trim() });
  }
  return found;
}

/**
 * A gap and a dangling citation are defects; a decision nobody cites may be enforced by absence.
 * @returns {{text: string, fatal: boolean}[]}
 */
export function registerProblems(defined, sites, decisionsPath) {
  const problems = [];
  for (const [prefix, series] of sequences(defined)) {
    const highest = series[series.length - 1];
    const missing = [];
    for (let number = 1; number <= highest.number; number += 1) {
      if (!series.some((entry) => entry.number === number)) missing.push(number);
    }
    if (missing.length > 0) {
      problems.push({ text: `${prefix}: ${missing.length} gap(s) below ${highest.id}`, fatal: true });
    }
  }
  for (const id of [...defined].sort()) {
    const uses = (sites.get(id) ?? []).filter((site) => site.file !== decisionsPath);
    if (uses.length === 0) {
      problems.push({ text: `${id}: defined and never cited — delete it, or cite it`, fatal: false });
    }
  }
  for (const id of [...sites.keys()].sort()) {
    if (!defined.has(id)) {
      problems.push({ text: `${id}: cited and not defined in ${decisionsPath}`, fatal: true });
    }
  }
  return problems;
}

/** Pairs close enough to be one decision, strongest first. */
export function mergeCandidates(rows, threshold = 0.25) {
  const scored = rows.map((row) => ({ ...row, terms: terms(`${row.decision} ${row.rule}`) }));
  const pairs = [];
  for (let i = 0; i < scored.length; i += 1) {
    for (let j = i + 1; j < scored.length; j += 1) {
      const score = similarity(scored[i].terms, scored[j].terms);
      if (score < threshold) continue;
      const shared = [...scored[i].terms].filter((term) => scored[j].terms.has(term)).sort();
      pairs.push({ left: scored[i].id, right: scored[j].id, score, shared });
    }
  }
  return pairs.sort((a, b) => b.score - a.score);
}

/** A decision whose rule a check already states is said twice: once here, once in the generated map. */
export function alreadyChecked(rows, checks, threshold = 0.7) {
  const named = checks.map((check) => ({ ...check, terms: terms(check.description) }));
  const found = [];
  for (const row of rows) {
    const ruleTerms = terms(row.rule);
    for (const check of named) {
      const score = similarity(ruleTerms, check.terms);
      if (score >= threshold) found.push({ id: row.id, check: check.name, score });
    }
  }
  return found.sort((a, b) => b.score - a.score);
}

/** How far a decision reaches: one area means it is that area's rule, not the repository's. */
export function reach(sites, id, decisionsPath) {
  const areas = new Set();
  let files = 0;
  for (const site of sites.get(id) ?? []) {
    if (site.file === decisionsPath) continue;
    files += 1;
    const parts = site.file.split("/");
    areas.add(parts.length > 2 ? parts.slice(0, 2).join("/") : parts[0]);
  }
  return { files, areas: [...areas].sort() };
}

/** Every row asked to earn its id. Each verdict is a prompt for a person, never a finding. */
export function audit(rows, sites, decisionsPath, checks = []) {
  const verdicts = rows.map((row) => {
    const { files, areas } = reach(sites, row.id, decisionsPath);
    const verdict = files === 0 ? "abort?" : areas.length === 1 && files === 1 ? "inline?" : areas.length === 1 ? "local?" : "keep";
    return { id: row.id, decision: row.decision, files, areas, verdict };
  });
  return { verdicts, merges: mergeCandidates(rows), checked: alreadyChecked(rows, checks) };
}
