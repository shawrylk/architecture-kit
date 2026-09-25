// Test path mirror: in every configured root, a test lives in the tests folder at its source's path,
// never beside it in src. A testOnly root holds test support, so its tests name no source file.

const TEST_SUFFIX = /\.test\.[cm]?[jt]sx?$/;
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/;

const folder = (value) => value.replace(/\/+$/, "");
const holds = (dir, file) => file.startsWith(`${dir}/`);
const named = (value) => typeof value === "string" && folder(value) !== "";

/** The roots as clean folders, or the problems that name each malformed one. */
function readRoots(roots) {
  if (!Array.isArray(roots)) {
    const detail = `testMirror.roots must be a list of { src, tests, testOnly? }, got ${JSON.stringify(roots)}`;
    return { valid: [], problems: [{ path: "qc.config.json", rule: "invalid-mirror-root", detail }] };
  }
  const valid = [];
  const problems = [];
  roots.forEach((root, index) => {
    if (named(root?.src) && named(root?.tests)) {
      valid.push({ src: folder(root.src), tests: folder(root.tests), testOnly: root.testOnly === true });
      return;
    }
    const detail = `testMirror.roots[${index}] needs a src folder and a tests folder, got ${JSON.stringify(root)}`;
    problems.push({ path: "qc.config.json", rule: "invalid-mirror-root", detail });
  });
  return { valid, problems };
}

/** Every folder the well-formed roots name, once each: the folders a caller walks for this gate. */
export function mirrorFolders(roots) {
  const { valid } = readRoots(roots);
  return [...new Set(valid.flatMap((root) => [root.src, root.tests]))];
}

function judge(testFile, root, srcStems) {
  if (!holds(root.tests, testFile)) {
    const detail = `${testFile}: a test in ${root.src}/ lives in ${root.tests}/, at the path that mirrors its source`;
    return { path: testFile, rule: "unmirrored-test", detail };
  }
  if (root.testOnly) return null;
  const stem = testFile.slice(root.tests.length + 1).replace(TEST_SUFFIX, "");
  const source = `${root.src}/${stem}`;
  if (srcStems.has(source) || srcStems.has(`${source}/index`)) return null;
  const detail = `${testFile}: no source at ${source} or ${source}/index for this test in ${root.tests}/`;
  return { path: testFile, rule: "orphaned-test", detail };
}

/**
 * A test is judged by the first root whose tests folder holds it, else by the first whose src
 * folder does. A test in no root is not this gate's concern.
 *
 * @param {string[]} testFiles repository-relative paths of the test files
 * @param {string[]} srcFiles repository-relative paths of the source files
 * @param {{src: string, tests: string, testOnly?: boolean}[]} roots `testMirror.roots`
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkTestMirror(testFiles, srcFiles, roots) {
  const { valid, problems } = readRoots(roots);
  const srcStems = new Set(srcFiles.map((file) => file.replace(SOURCE_EXTENSION, "")));
  for (const testFile of testFiles) {
    const root = valid.find((each) => holds(each.tests, testFile)) ?? valid.find((each) => holds(each.src, testFile));
    const problem = root ? judge(testFile, root, srcStems) : null;
    if (problem) problems.push(problem);
  }
  return problems;
}
