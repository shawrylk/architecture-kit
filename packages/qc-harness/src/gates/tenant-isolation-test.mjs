// Row-level security and the scoped repository are checked by the other gates; the proof that a
// second tenant reads nothing is a test a person writes. This asks that each feature which owns a
// tenant table has one, by naming the helper the repository wrote for it.
//
// It asserts a test in the feature's own folder names the helper — not that the test is good.

import { tenantScopedTables } from "./tenant-tables.mjs";

const DEFAULT_TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The feature folder a path sits in, or null when it is outside every feature root. */
function featureOf(file, roots) {
  for (const root of roots) {
    const prefix = root === "" ? "" : `${root.replace(/\/+$/, "")}/`;
    if (!file.startsWith(prefix)) continue;
    const [name, ...rest] = file.slice(prefix.length).split("/");
    if (rest.length > 0) return `${prefix}${name}`;
  }
  return null;
}

/**
 * @param {{path: string, contents: string}[]} files every source file under the feature roots, tests included
 * @param {{helper?: string|null, featureRoots?: string[], tableFactory?: string, column?: string, testFile?: RegExp}} [options]
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkTenantIsolationTests(files, options = {}) {
  const { helper = null, featureRoots = [], testFile = DEFAULT_TEST_FILE } = options;
  if (!helper) {
    return [
      {
        path: "qc.config.json",
        rule: "isolation-helper-unset",
        detail: "gates.tenant-isolation-test is on, but tenant.isolationHelper names no helper — name the function a two-tenant test calls",
      },
    ];
  }
  const named = new RegExp(`(?<![\\w$])${escape(helper)}(?![\\w$])`);
  const tables = new Map();
  const proven = new Set();
  for (const { path, contents } of files) {
    const feature = featureOf(path, featureRoots);
    if (feature === null) continue;
    if (testFile.test(path)) {
      if (named.test(contents)) proven.add(feature);
      continue;
    }
    const found = tenantScopedTables(contents, options);
    if (found.length > 0) tables.set(feature, [...(tables.get(feature) ?? []), ...found]);
  }
  const problems = [];
  for (const [feature, names] of [...tables].sort(([a], [b]) => a.localeCompare(b))) {
    if (proven.has(feature)) continue;
    problems.push({
      path: feature,
      rule: "untested-tenant-isolation",
      detail: `owns tenant table(s) ${[...new Set(names)].sort().join(", ")}, but no test in this folder calls '${helper}' — nothing proves a second tenant reads zero rows`,
    });
  }
  return problems;
}

/** The features that own a tenant table, for the line `qc check` prints. */
export function tenantFeatures(files, options = {}) {
  const { featureRoots = [], testFile = DEFAULT_TEST_FILE } = options;
  const owners = new Set();
  for (const { path, contents } of files) {
    const feature = featureOf(path, featureRoots);
    if (feature === null || testFile.test(path)) continue;
    if (tenantScopedTables(contents, options).length > 0) owners.add(feature);
  }
  return [...owners];
}
