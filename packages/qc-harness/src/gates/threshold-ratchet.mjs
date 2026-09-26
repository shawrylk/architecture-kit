// A threshold only tightens, unless a decision says why it loosens. Every brief says "never lower a
// threshold", and a rule a gate checks holds under pressure where a sentence does not.

import { escape } from "../eslint/options.mjs";

function loosened(comparator, was, now) {
  if (comparator === "max") return now > was;
  if (comparator === "min") return now < was;
  return false;
}

/**
 * @param {object} before  the registry's `gates` at the merge base
 * @param {object} after  the registry's `gates` now
 * @param {{path: string, text: string}[]} adrs  the ADR files the diff changes, with their text
 * @param {{registry: string}} options  the registry path, as a problem names it
 */
export function checkThresholdRatchet(before, after, adrs, { registry }) {
  const problems = [];
  const citedByAdr = (key) => {
    const named = new RegExp(`\\b${escape(key)}\\b`);
    return adrs.some((adr) => named.test(adr.text));
  };
  for (const [key, entry] of Object.entries(after)) {
    const was = before[key];
    // The comparator in force before the change is the policy the change answers to.
    if (typeof was?.value !== "number" || typeof entry?.value !== "number") continue;
    if (!loosened(was.comparator, was.value, entry.value)) continue;
    if (citedByAdr(key)) continue;
    problems.push({
      path: registry,
      rule: "loosened-threshold",
      detail: `'${key}' moves from ${was.value} to ${entry.value}, and a ${was.comparator} that moves this way loosens; a changed ADR must name '${key}'`,
    });
  }
  // Dropping a limit is the widest loosening of all, so it answers to the same rule.
  for (const [key, was] of Object.entries(before)) {
    if (key in after || typeof was?.value !== "number" || citedByAdr(key)) continue;
    problems.push({
      path: registry,
      rule: "removed-threshold",
      detail: `'${key}' (${was.comparator} ${was.value}) is removed; a changed ADR must name '${key}'`,
    });
  }
  return problems;
}
