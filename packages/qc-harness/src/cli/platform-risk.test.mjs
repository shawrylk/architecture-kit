import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { riskHits } from "./platform-risk.mjs";

const cli = fileURLToPath(new URL("./qc.mjs", import.meta.url));

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


function commandRepo(t, source = 'const value = 1;\n') {
  const root = mkdtempSync(path.join(tmpdir(), 'qc-platform-risk-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', process.env.GIT_AUTHOR_EMAIL || 'test@example.com');
  git('commit', '--allow-empty', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileSync(path.join(root, 'code.mjs'), source);
  git('add', '.');
  git('commit', '-qm', 'change');
  const run = (args = [], env = {}) => spawnSync(process.execPath, [cli, 'platform-risk', ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '', ...env },
  });
  return { root, run };
}

test('platform-risk command reports no hits using origin/main by default', (t) => {
  const { run } = commandRepo(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'risky=false\n');
});

test('platform-risk command reports changed line hits with an explicit base', (t) => {
  const { run } = commandRepo(t, 'const value = 1;\nprocess.platform;\n');
  const result = run(['--base', 'HEAD^']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'code.mjs:2 process.platform\nrisky=true\n');
});

test('platform-risk command prints at most ten hits', (t) => {
  const { run } = commandRepo(t, 'process.platform;\n'.repeat(12));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    ...Array.from({ length: 10 }, (_, i) => `code.mjs:${i + 1} process.platform`), 'risky=true',
  ]);
});

test('platform-risk command appends its boolean to GITHUB_OUTPUT', (t) => {
  for (const risky of [false, true]) {
    const { root, run } = commandRepo(t, risky ? 'process.platform;\n' : 'const value = 1;\n');
    const output = path.join(root, 'output');
    writeFileSync(output, 'existing=value\n');
    const result = run([], { GITHUB_OUTPUT: output });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, 'utf8'), `existing=value\nrisky=${risky}\n`);
  }
});

test('platform-risk command fails on a bad base without publishing a safe result', (t) => {
  const { root, run } = commandRepo(t);
  const output = path.join(root, 'output');
  writeFileSync(output, 'existing=value\n');
  const result = run(['--base', 'missing-base'], { GITHUB_OUTPUT: output });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing-base/);
  assert.doesNotMatch(result.stdout, /risky=/);
  assert.equal(readFileSync(output, 'utf8'), 'existing=value\n');
});


test('platform-risk command rejects malformed arguments', (t) => {
  const { run } = commandRepo(t);
  for (const args of [['--base'], ['--base', '--unknown'], ['--unknown'], ['extra'], ['--base', 'HEAD', 'extra']]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage:/);
    assert.doesNotMatch(result.stdout, /risky=/);
  }
});

test('platform-risk command fails when GITHUB_OUTPUT cannot be written', (t) => {
  const { root, run } = commandRepo(t);
  const result = run([], { GITHUB_OUTPUT: root });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EISDIR|EPERM|EACCES/);
  assert.doesNotMatch(result.stdout, /risky=/);
});
