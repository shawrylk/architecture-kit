// Test path mirror: a test lives in its root's tests folder at its source's path, never in src. A folder
// root matches a source folder, for a block test that spans files; a testOnly root names no source.

const TEST_SUFFIX = /\.test\.[cm]?[jt]sx?$/;
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/;

const folder = (value) => value.replace(/\/+$/, "");
const holds = (dir, file) => file.startsWith(`${dir}/`);
const named = (value) => typeof value === "string" && folder(value) !== "";
const MATCHES = ["file", "folder"];

/** The roots as clean folders, or the problems that name each malformed one. */
function readRoots(roots) {
  if (!Array.isArray(roots)) {
    const detail = `testMirror.roots must be a list of { src, tests, match?, testOnly? }, got ${JSON.stringify(roots)}`;
    return { valid: [], problems: [{ path: "qc.config.json", rule: "invalid-mirror-root", detail }] };
  }
  const valid = [];
  const problems = [];
  roots.forEach((root, index) => {
    const match = root?.match ?? "file";
    if (named(root?.src) && named(root?.tests) && MATCHES.includes(match)) {
      valid.push({ src: folder(root.src), tests: folder(root.tests), match, testOnly: root.testOnly === true });
      return;
    }
    const detail = `testMirror.roots[${index}] needs a src folder, a tests folder, and a match of ${MATCHES.join(" or ")}, got ${JSON.stringify(root)}`;
    problems.push({ path: "qc.config.json", rule: "invalid-mirror-root", detail });
  });
  return { valid, problems };
}

/** Every folder the well-formed roots name, once each: the folders a caller walks for this gate. */
export function mirrorFolders(roots) {
  const { valid } = readRoots(roots);
  return [...new Set(valid.flatMap((root) => [root.src, root.tests]))];
}

function judge(testFile, root, srcStems, srcFolders) {
  if (!holds(root.tests, testFile)) {
    const detail = `${testFile}: a test in ${root.src}/ lives in ${root.tests}/, at the path that mirrors its source`;
    return { path: testFile, rule: "unmirrored-test", detail };
  }
  if (root.testOnly) return null;
  const stem = testFile.slice(root.tests.length + 1).replace(TEST_SUFFIX, "");
  if (root.match === "folder") {
    const within = stem.includes("/") ? stem.slice(0, stem.lastIndexOf("/")) : "";
    const sourceFolder = within ? `${root.src}/${within}` : root.src;
    if (srcFolders.has(sourceFolder)) return null;
    const detail = `${testFile}: no source folder at ${sourceFolder} for this test in ${root.tests}/`;
    return { path: testFile, rule: "orphaned-test", detail };
  }
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
 * @param {{src: string, tests: string, match?: "file" | "folder", testOnly?: boolean}[]} roots `testMirror.roots`
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkTestMirror(testFiles, srcFiles, roots) {
  const { valid, problems } = readRoots(roots);
  const srcStems = new Set(srcFiles.map((file) => file.replace(SOURCE_EXTENSION, "")));
  const srcFolders = new Set();
  for (const file of srcFiles) {
    for (let at = file.lastIndexOf("/"); at > 0; at = file.lastIndexOf("/", at - 1)) srcFolders.add(file.slice(0, at));
  }
  for (const testFile of testFiles) {
    const root = valid.find((each) => holds(each.tests, testFile)) ?? valid.find((each) => holds(each.src, testFile));
    const problem = root ? judge(testFile, root, srcStems, srcFolders) : null;
    if (problem) problems.push(problem);
  }
  return problems;
}
