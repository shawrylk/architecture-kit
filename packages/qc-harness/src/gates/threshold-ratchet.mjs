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
  for (const [key, entry] of Object.entries(after)) {
    const was = before[key];
    // The comparator in force before the change is the policy the change answers to.
    if (typeof was?.value !== "number" || typeof entry?.value !== "number") continue;
    if (!loosened(was.comparator, was.value, entry.value)) continue;
    const named = new RegExp(`\\b${escape(key)}\\b`);
    if (adrs.some((adr) => named.test(adr.text))) continue;
    problems.push({
      path: registry,
      rule: "loosened-threshold",
      detail: `'${key}' moves from ${was.value} to ${entry.value}, and a ${was.comparator} that moves this way loosens; a changed ADR must name '${key}'`,
    });
  }
  return problems;
}
