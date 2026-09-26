// A test named for integration has to reach the thing it integrates with. One that imports
// only a test runner and the kernel builds its own subject and asserts about it, so it passes
// for every failure a user would meet.

/** Each `import ... from "<specifier>"`, so a name in a comment or a string is not one. */
const IMPORT_SPECIFIER = /^\s*import\s[\s\S]*?from\s+"([^"]+)"/gm;

/**
 * A test inside a product root reaches its neighbours with `./`, so any relative import counts.
 * One outside has to name the product root it climbs into, or import a product package.
 * @param {string} source
 * @param {string} file the repository-relative path
 * @param {{productRoots: string[], productPackages: string[]}} options
 * @returns {number}
 */
export function productImportCount(source, file, { productRoots, productPackages }) {
  const inProduct = productRoots.some((root) => file.startsWith(`${root}/`));
  const productPackage = productPackages.length > 0 ? new RegExp(productPackages.join("|")) : null;
  let count = 0;
  for (const [, specifier] of source.matchAll(IMPORT_SPECIFIER)) {
    if (productPackage?.test(specifier)) count += 1;
    else if (!specifier.startsWith(".")) continue;
    else if (inProduct) count += 1;
    else if (productRoots.some((root) => specifier.split("/").includes(root))) count += 1;
  }
  return count;
}

/**
 * @param {{path: string, contents: string}[]} subjects every file the subject pattern matched
 * @param {{productRoots: string[], productPackages: string[]}} options
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkIntegrationImports(subjects, options) {
  if (subjects.length === 0) {
    return [{
      path: "qc.config.json",
      rule: "no-integration-tests",
      detail: "no file matches integrationImports.subject, so this gate is checking nothing",
    }];
  }
  return subjects
    .filter(({ path, contents }) => productImportCount(contents, path, options) === 0)
    .map(({ path }) => ({
      path,
      rule: "integration-without-product",
      detail: "imports no product module, so it can only assert about subjects it declares itself",
    }));
}
