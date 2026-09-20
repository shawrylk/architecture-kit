// A gate is tested code: every gate ships a case that must fail. A warning is not a
// check, and a gate that has never failed has never been tested. docs/decisions.md.
//
// The kit's own gates are proven by its suite. This one covers the gates a repository
// writes for itself, which nothing else is watching.

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NAME = /([^/]+?)\.[cm]?[jt]sx?$/;

function stemOf(path) {
  const found = NAME.exec(path);
  return found === null ? path : found[1];
}

/**
 * @param {{path: string, contents: string}[]} checks  a repository's own gate sources
 * @param {{path: string, contents: string}[]} tests
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkGatesAreTested(checks, tests) {
  const problems = [];
  for (const { path, contents } of checks) {
    const stem = stemOf(path);
    const exported = [...contents.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(\w+)/g)].map((m) => m[1]);
    // The stem counts only where a test imports the file. A bare word matches English:
    // a gate called `nothing` read as proven because a test said "yields nothing".
    const imported = new RegExp(`${escape(stem)}\\.[cm]?[jt]sx?`);
    const named =
      exported.length > 0
        ? new RegExp(`${imported.source}|\\b(?:${exported.map(escape).join("|")})\\b`)
        : imported;
    if (!tests.some((test) => named.test(test.contents))) {
      problems.push({
        path,
        rule: "unproven-gate",
        detail: `no test names ${stem} or anything it exports — a gate that has never failed has never been tested`,
      });
    }
  }
  return problems;
}
