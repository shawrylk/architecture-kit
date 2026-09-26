// A closed set is a value, and no type asks whether a declared key is ever written. So a key
// either has a writer or names the mutation it waits for, and the waiting list can only shrink.

/** The first group of each match of `pattern` in `source`. */
export function matchedKeys(source, pattern) {
  return [...source.matchAll(new RegExp(pattern, "g"))].map((match) => match[1]);
}

/**
 * @param {string[]} declared the keys the set's source declares
 * @param {Set<string>} written the keys some writer writes
 * @param {{name: string, source: string, declaredAhead?: Record<string, string>}} set
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkClosedSetWriters(declared, written, set) {
  const ahead = set.declaredAhead ?? {};
  const path = set.source;
  const problems = [];
  const push = (rule, detail) => problems.push({ path, rule, detail });
  if (declared.length === 0) {
    push("empty-closed-set", `${set.name}: the source declares no key, so this set checks nothing`);
    return problems;
  }
  for (const key of declared) {
    if (written.has(key) || key in ahead) continue;
    push("unwritten-key", `${key} is declared in ${set.name}, never written, and not listed as waiting for a mutation`);
  }
  for (const key of Object.keys(ahead)) {
    if (!declared.includes(key)) push("stale-declared-ahead", `${key} is listed as waiting but is no longer in ${set.name} — delete the entry`);
    if (written.has(key)) push("stale-declared-ahead", `${key} is listed as waiting but something writes it now — delete the entry`);
  }
  for (const key of written) {
    if (!declared.includes(key)) push("undeclared-write", `${key} is written but not declared in ${set.name}`);
  }
  return problems;
}
