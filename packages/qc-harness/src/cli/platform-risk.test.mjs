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
  assert.ok(riskHits('diff --git a/Foo b/foo\nrename from Foo\nrename to foo\n').some((hit) => hit.reason === 'path case change'));
  assert.ok(riskHits('diff --git a/a b/b\nrename from a\nrename to b\n').some((hit) => hit.reason === 'rename'));
  assert.ok(riskHits('diff --git a/link b/link\nnew file mode 120000\n').some((hit) => hit.reason === 'symlink'));
});
