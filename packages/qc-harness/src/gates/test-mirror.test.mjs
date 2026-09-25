import test from "node:test";
import assert from "node:assert/strict";
import { defaults } from "../config.mjs";
import { checkTestMirror } from "./test-mirror.mjs";

const FRONTEND = [{ src: "frontend/src", tests: "frontend/tests" }];
const TWO_ROOTS = [...FRONTEND, { src: "backend/src", tests: "backend/tests" }];
const verdict = (problems) => problems.map(({ path, rule }) => ({ path, rule }));

test("a test perfectly mirroring a source file passes", () => {
  const tests = ["frontend/tests/features/photos/slices/get-photo.test.ts"];
  const src = ["frontend/src/features/photos/slices/get-photo.ts"];
  assert.deepEqual(checkTestMirror(tests, src, FRONTEND), []);
});

test("a test mirroring a view folder index passes", () => {
  const tests = ["frontend/tests/features/photos/components/photo-viewer.test.tsx"];
  const src = ["frontend/src/features/photos/components/photo-viewer/index.ts"];
  assert.deepEqual(checkTestMirror(tests, src, FRONTEND), []);
});

test("a test file remaining in frontend/src is flagged as unmirrored", () => {
  const tests = ["frontend/src/features/photos/slices/get-photo.test.ts"];
  const src = ["frontend/src/features/photos/slices/get-photo.ts"];
  const problems = checkTestMirror(tests, src, FRONTEND);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "unmirrored-test");
});

test("an orphaned test with no matching source file is flagged", () => {
  const tests = ["frontend/tests/features/photos/slices/unknown-slice.test.ts"];
  const src = ["frontend/src/features/photos/slices/get-photo.ts"];
  const problems = checkTestMirror(tests, src, FRONTEND);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "orphaned-test");
});

test("with two roots, a colocated backend test fails and a mirrored one passes", () => {
  const tests = ["backend/src/features/tasks/slices/assign.test.ts", "backend/tests/features/tasks/slices/close.test.ts"];
  const src = ["backend/src/features/tasks/slices/assign.ts", "backend/src/features/tasks/slices/close.ts"];
  const problems = checkTestMirror(tests, src, TWO_ROOTS);
  assert.deepEqual(verdict(problems), [{ path: "backend/src/features/tasks/slices/assign.test.ts", rule: "unmirrored-test" }]);
  assert.ok(problems[0].detail.includes("backend/src/") && problems[0].detail.includes("backend/tests/"), problems[0].detail);
});

test("an orphaned test names the root it belongs to", () => {
  const problems = checkTestMirror(["backend/tests/features/tasks/gone.test.ts"], ["frontend/src/features/tasks/gone.ts"], TWO_ROOTS);
  assert.deepEqual(verdict(problems), [{ path: "backend/tests/features/tasks/gone.test.ts", rule: "orphaned-test" }]);
  assert.ok(problems[0].detail.includes("backend/src/features/tasks/gone"), problems[0].detail);
  assert.ok(problems[0].detail.includes("backend/tests/"), problems[0].detail);
});

test("the default config is the one frontend root, and gives today's frontend-only verdict", () => {
  assert.deepEqual(defaults.testMirror.roots, FRONTEND);
  const tests = [
    "frontend/src/features/photos/slices/get-photo.test.ts",
    "frontend/tests/features/photos/slices/get-photo.test.ts",
    "frontend/tests/features/photos/slices/unknown-slice.test.ts",
    "backend/src/features/tasks/slices/assign.test.ts",
  ];
  const src = ["frontend/src/features/photos/slices/get-photo.ts", "backend/src/features/tasks/slices/assign.ts"];
  assert.deepEqual(verdict(checkTestMirror(tests, src, defaults.testMirror.roots)), [
    { path: "frontend/src/features/photos/slices/get-photo.test.ts", rule: "unmirrored-test" },
    { path: "frontend/tests/features/photos/slices/unknown-slice.test.ts", rule: "orphaned-test" },
  ]);
});

test("a testOnly root accepts a test with no source stem", () => {
  const tests = ["packages/testing/tests/interop/cross-tenant.test.ts"];
  const root = { src: "packages/testing/src", tests: "packages/testing/tests" };
  assert.deepEqual(checkTestMirror(tests, [], [{ ...root, testOnly: true }]), []);
  assert.deepEqual(verdict(checkTestMirror(tests, [], [root])), [{ path: tests[0], rule: "orphaned-test" }]);
});

test("a root whose tests folder is its src folder judges a test as a test, so testOnly covers it", () => {
  const root = { src: "packages/testing/src", tests: "packages/testing/src", testOnly: true };
  assert.deepEqual(checkTestMirror(["packages/testing/src/interop.test.ts"], [], [root]), []);
});

test("a root claims its own folder only, not a sibling that shares its prefix", () => {
  assert.deepEqual(checkTestMirror(["frontend/src-legacy/old.test.ts"], [], FRONTEND), []);
});

test("a test and its source match whatever script extension each one carries", () => {
  const tests = ["frontend/tests/platform/format.test.mjs", "frontend/tests/platform/parse.test.js"];
  const src = ["frontend/src/platform/format.mjs", "frontend/src/platform/parse.ts"];
  assert.deepEqual(checkTestMirror(tests, src, FRONTEND), []);
});

test("a root without a src and a tests folder is a problem that names its key, not a silent pass", () => {
  const problems = checkTestMirror(["backend/src/a.test.ts"], [], [{ src: "backend/src", test: "backend/tests" }]);
  assert.deepEqual(verdict(problems), [{ path: "qc.config.json", rule: "invalid-mirror-root" }]);
  assert.ok(problems[0].detail.includes("testMirror.roots[0]"), problems[0].detail);
});

const BACKEND_BY_FOLDER = [{ src: "backend/src", tests: "backend/tests", match: "folder" }];
const BACKEND_SOURCES = ["backend/src/features/audit-log/schema.ts", "backend/src/features/audit-log/shared/queries.ts"];

test("a folder root accepts a block test whose folder mirrors a source folder", () => {
  const problems = checkTestMirror(["backend/tests/features/audit-log/record.test.ts"], BACKEND_SOURCES, BACKEND_BY_FOLDER);
  assert.deepEqual(problems, []);
});

test("a folder root refuses a test whose folder mirrors no source folder", () => {
  const problems = checkTestMirror(["backend/tests/features/gone/record.test.ts"], BACKEND_SOURCES, BACKEND_BY_FOLDER);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "orphaned-test");
  assert.match(problems[0].detail, /backend\/src\/features\/gone/);
});

test("a folder root still refuses a test left beside its source in src", () => {
  const problems = checkTestMirror(["backend/src/features/audit-log/record.test.ts"], BACKEND_SOURCES, BACKEND_BY_FOLDER);
  assert.equal(problems[0].rule, "unmirrored-test");
});

test("a file root still refuses the same block test, and file is the default", () => {
  for (const roots of [[{ src: "backend/src", tests: "backend/tests", match: "file" }], [{ src: "backend/src", tests: "backend/tests" }]]) {
    const problems = checkTestMirror(["backend/tests/features/audit-log/record.test.ts"], BACKEND_SOURCES, roots);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].rule, "orphaned-test");
  }
});

test("a match value other than file or folder is an invalid root", () => {
  const problems = checkTestMirror([], BACKEND_SOURCES, [{ src: "backend/src", tests: "backend/tests", match: "stem" }]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "invalid-mirror-root");
});
