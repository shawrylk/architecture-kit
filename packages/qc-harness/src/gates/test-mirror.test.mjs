import test from "node:test";
import assert from "node:assert/strict";
import { checkTestMirror } from "./test-mirror.mjs";

test("a test perfectly mirroring a source file passes", () => {
  const tests = ["frontend/tests/features/photos/slices/get-photo.test.ts"];
  const src = ["frontend/src/features/photos/slices/get-photo.ts"];
  assert.deepEqual(checkTestMirror(tests, src), []);
});

test("a test mirroring a view folder index passes", () => {
  const tests = ["frontend/tests/features/photos/components/photo-viewer.test.tsx"];
  const src = ["frontend/src/features/photos/components/photo-viewer/index.ts"];
  assert.deepEqual(checkTestMirror(tests, src), []);
});

test("a test file remaining in frontend/src is flagged as unmirrored", () => {
  const tests = ["frontend/src/features/photos/slices/get-photo.test.ts"];
  const src = ["frontend/src/features/photos/slices/get-photo.ts"];
  const problems = checkTestMirror(tests, src);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "unmirrored-test");
});

test("an orphaned test with no matching source file is flagged", () => {
  const tests = ["frontend/tests/features/photos/slices/unknown-slice.test.ts"];
  const src = ["frontend/src/features/photos/slices/get-photo.ts"];
  const problems = checkTestMirror(tests, src);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "orphaned-test");
});
