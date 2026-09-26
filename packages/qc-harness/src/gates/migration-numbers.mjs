// Migration numbers are handed out by hand, so two branches can take the same one, or a rebase can
// drop one. Each numeric prefix is unique, and the run from the lowest to the highest has no gap.

const MIGRATION = /^(\d+)_.*\.sql$/;

/**
 * @param {string[]} names  the names in the migrations folder
 * @param {string} dir  the folder, as a problem names it
 */
export function checkMigrationNumbers(names, dir) {
  const byNumber = new Map();
  for (const name of names) {
    const found = MIGRATION.exec(name);
    if (found === null) continue;
    const number = Number(found[1]);
    byNumber.set(number, [...(byNumber.get(number) ?? []), name]);
  }
  const problems = [];
  for (const [number, files] of byNumber) {
    if (files.length > 1) {
      problems.push({ path: dir, rule: "duplicate-migration-number", detail: `${files.sort().join(", ")} share number ${number}; give each migration its own` });
    }
  }
  const numbers = [...byNumber.keys()].sort((a, b) => a - b);
  const missing = [];
  for (let number = numbers[0]; number < numbers.at(-1); number += 1) {
    if (!byNumber.has(number)) missing.push(number);
  }
  if (missing.length > 0) {
    problems.push({ path: dir, rule: "migration-number-gap", detail: `no migration holds number ${missing.join(", ")}; the numbers run from ${numbers[0]} to ${numbers.at(-1)} with no gap` });
  }
  return problems;
}
