import { test } from "node:test";
import assert from "node:assert/strict";
import { riskHits } from "./platform-risk.mjs";

for (const source of ['listen(3000)', 'listen(7)', 'const port = 8080', '"foo/bar"', '"foo\\\\bar"', '"/tmp"', 'split("/")', '"\\r\\n"', 'EPERM', 'process.platform']) {
  test(`flags added platform risk: ${source}`, () => {
    assert.equal(riskHits(`diff --git a/a.js b/a.js\n+++ b/a.js\n@@ -1 +7 @@\n+${source}\n`)[0].file, 'a.js');
    assert.equal(riskHits(`+++ b/a.js\n@@ -1 +7 @@\n+${source}\n`)[0].line, 7);
  });
}
test('ignores removed lines and context', () => {
  assert.deepEqual(riskHits('+++ b/a.js\n@@ -1,2 +1 @@\n-EPERM\n process.platform\n+const x = 1;\n'), []);
});
test('port zero requests a free port', () => {
  assert.deepEqual(riskHits('+++ b/a.js\n@@ -0,0 +1 @@\n+server.listen(0);\n'), []);
});
test('uses new-file line numbers across multiple hunks and files', () => {
  const hits = riskHits('+++ b/first.js\n@@ -1 +4 @@\n+EPERM\n@@ -10 +15 @@\n+process.platform\n+++ b/second.js\n@@ -0,0 +1 @@\n+listen(80)\n');
  assert.deepEqual(hits.map(({ file, line }) => [file, line]), [['first.js', 4], ['first.js', 15], ['second.js', 1]]);
});
test('flags renames, path case changes, and symlinks', () => {
  assert.ok(riskHits('diff --git a/Foo.js b/foo.js\nrename from Foo.js\nrename to foo.js\n').some((hit) => hit.reason === 'path case change'));
  assert.ok(riskHits('diff --git a/a.js b/b.js\nrename from a.js\nrename to b.js\n').some((hit) => hit.reason === 'rename'));
  assert.ok(riskHits('diff --git a/link.js b/link.js\nnew file mode 120000\n').some((hit) => hit.reason === 'symlink'));
});

test('ignores prose content, renames, case changes, and symlinks', () => {
  for (const extension of ['md', 'mdx', 'txt', 'rst', 'adoc', 'html', 'svg', 'json', 'yaml', 'yml']) {
    assert.deepEqual(riskHits(`diff --git a/Guide.${extension} b/guide.${extension}\nrename from Guide.${extension}\nrename to guide.${extension}\nnew file mode 120000\n+++ b/guide.${extension}\n@@ -0,0 +1 @@\n+listen(3000); "foo/bar"; "\\r\\n"; EPERM; process.platform\n`), []);
  }
});

test('scans code files after a prose file', () => {
  for (const extension of ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'sh', 'bash', 'ps1', 'py', 'go', 'rs', 'java', 'cs', 'c', 'cpp', 'rb', 'php']) {
    const hits = riskHits(`+++ b/guide.md\n@@ -0,0 +1 @@\n+process.platform\n+++ b/code.${extension}\n@@ -0,0 +3 @@\n+EPERM\n`);
    assert.deepEqual(hits, [{ file: `code.${extension}`, line: 3, reason: 'EPERM' }]);
  }
});
