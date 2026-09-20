// Test path mirror: every frontend test must mirror a source file in frontend/src.
// Tests in frontend/src/ are disallowed (they must live in frontend/tests/).
// Tests in frontend/tests/ must not be orphaned (a matching source file must exist).

const TEST_PATTERN = /\.test\.(tsx?)$/;

/**
 * Checks that frontend tests strictly mirror frontend/src/ files and are not orphaned.
 *
 * @param {string[]} testFiles Relative paths of all test files (e.g. frontend/tests/...)
 * @param {string[]} srcFiles Relative paths of all source files (e.g. frontend/src/...)
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkTestMirror(testFiles, srcFiles) {
  const problems = [];
  const srcStems = new Set(
    srcFiles.map((f) => f.replace(/\.(tsx?)$/, ""))
  );

  for (const testFile of testFiles) {
    if (testFile.startsWith("frontend/src/")) {
      problems.push({
        path: testFile,
        rule: "unmirrored-test",
        detail: `${testFile}: test files must live in frontend/tests/ mirroring the src path`,
      });
      continue;
    }

    if (testFile.startsWith("frontend/tests/")) {
      const rel = testFile.slice("frontend/tests/".length);
      const stem = rel.replace(TEST_PATTERN, "");
      const directSource = `frontend/src/${stem}`;
      const indexSource = `frontend/src/${stem}/index`;

      if (!srcStems.has(directSource) && !srcStems.has(indexSource)) {
        problems.push({
          path: testFile,
          rule: "orphaned-test",
          detail: `${testFile}: no matching source file at frontend/src/${stem}.{ts,tsx}`,
        });
      }
    }
  }

  return problems;
}
