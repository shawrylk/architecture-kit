import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { onChangedLines, parseDiff } from "./lint-changed.mjs";

const QC = path.join(path.dirname(fileURLToPath(import.meta.url)), "qc.mjs");

test("a diff gives the new-side lines of each hunk, and a deleted file is absent", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -3 +3 @@ x",
    "@@ -10,0 +11,2 @@ y",
    "@@ -20,2 +22,0 @@ z",
    "diff --git a/src/gone.ts b/src/gone.ts",
    "--- a/src/gone.ts",
    "+++ /dev/null",
    "@@ -1,4 +0,0 @@",
  ].join("\n");
  const changed = parseDiff(diff);
  assert.deepEqual([...changed.keys()], ["src/a.ts"]);
  assert.deepEqual([...changed.get("src/a.ts")], [3, 11, 12]);
});

test("only a problem on a changed line counts; a fatal one and a new file count whole", () => {
  const root = path.resolve("/repo");
  const results = [
    { filePath: path.join(root, "src", "a.ts"), messages: [{ line: 3, severity: 2 }, { line: 4, severity: 2 }, { fatal: true, severity: 2, line: 9 }] },
    { filePath: path.join(root, "src", "new.ts"), messages: [{ line: 40, severity: 1 }] },
  ];
  const changed = new Map([["src/a.ts", new Set([3])], ["src/new.ts", "all"]]);
  const { kept, skipped } = onChangedLines(results, changed, root);
  assert.deepEqual(kept.map(({ file, message }) => `${file}:${message.line}`), ["src/a.ts:3", "src/a.ts:9", "src/new.ts:40"]);
  assert.equal(skipped, 1);
});

/** A git repository with a real ESLint, linked from the kit's own install, and one rule: no-var. */
function repo(t) {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-lint-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const eslintDir = path.dirname(createRequire(import.meta.url).resolve("eslint/package.json"));
  mkdirSync(path.join(root, "node_modules"));
  symlinkSync(eslintDir, path.join(root, "node_modules", "eslint"), "junction");
  writeFileSync(path.join(root, "package.json"), '{ "type": "module" }\n');
  writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  writeFileSync(path.join(root, "qc.config.json"), '{ "featureRoots": [] }\n');
  writeFileSync(path.join(root, "eslint.config.mjs"), 'export default [{ files: ["**/*.mjs"], rules: { "no-var": "error", "no-console": "warn" } }];\n');
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "old.mjs"), "var legacy = 1;\nexport const kept = legacy;\n");
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--no-verify", "-m", "init");
  const qc = (...args) => spawnSync(process.execPath, [QC, "lint", ...args], { cwd: root, encoding: "utf8" });
  return { root, git, qc };
}

test("an older problem in a file the change edits is left alone, and the change passes", (t) => {
  const { root, qc } = repo(t);
  writeFileSync(path.join(root, "src", "old.mjs"), "var legacy = 1;\nexport const kept = legacy;\nexport const added = 2;\n");
  const result = qc();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /1 older problem\(s\) on lines this change leaves alone/);
});

test("a problem on a changed line fails, and a warning there prints but passes", (t) => {
  const { root, qc } = repo(t);
  writeFileSync(path.join(root, "src", "old.mjs"), "var legacy = 1;\nexport const kept = legacy;\nvar added = 2;\nexport { added };\n");
  const failed = qc();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /src\/old\.mjs:3:1 {2}error .*no-var/);
  writeFileSync(path.join(root, "src", "old.mjs"), "var legacy = 1;\nexport const kept = legacy;\nconsole.log(kept);\n");
  const warned = qc();
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /0 error\(s\) and 1 warning\(s\)/);
});

test("an untracked file counts whole, and --staged judges what the index holds", (t) => {
  const { root, git, qc } = repo(t);
  writeFileSync(path.join(root, "src", "new.mjs"), "var fresh = 1;\nexport { fresh };\n");
  assert.equal(qc().status, 1);
  assert.equal(qc("--staged").status, 0, "nothing is staged yet");
  git("add", "src/new.mjs");
  writeFileSync(path.join(root, "src", "new.mjs"), "const fresh = 1;\nexport { fresh };\n");
  const staged = qc("--staged");
  assert.equal(staged.status, 1, "the index still holds the var");
  assert.match(staged.stderr, /src\/new\.mjs:1:1 {2}error/);
});

test("a repository without ESLint skips the lint", (t) => {
  const { root, qc } = repo(t);
  rmSync(path.join(root, "node_modules"), { recursive: true, force: true });
  const result = qc();
  assert.equal(result.status, 0);
  assert.match(result.stdout, /lint skipped/);
});

test("qc lint applies the baseline per file and rule up to the recorded count", (t) => {
  const { root, qc } = repo(t);
  writeFileSync(path.join(root, "eslint-suppressions.json"), JSON.stringify({ "src/old.mjs": { "no-var": { count: 1 } } }));
  writeFileSync(path.join(root, "src", "old.mjs"), "var legacy = 2;\nexport const kept = legacy;\n");
  const suppressed = qc();
  assert.equal(suppressed.status, 0, suppressed.stderr);
  writeFileSync(path.join(root, "src", "old.mjs"), "var legacy = 2;\nexport const kept = legacy;\nvar added = 3;\n");
  assert.equal(qc().status, 1, "a count over the baseline still fails");
  writeFileSync(path.join(root, "src", "new.mjs"), "var fresh = 1;\n");
  const otherFile = qc();
  assert.equal(otherFile.status, 1, otherFile.stderr);
  assert.match(otherFile.stderr, /src\/new\.mjs:1:1.*no-var/);
});

test("qc lint fails stale baseline entries, including untouched and deleted files", (t) => {
  const { root, qc } = repo(t);
  const baseline = path.join(root, "eslint-suppressions.json");
  writeFileSync(baseline, JSON.stringify({ "src/old.mjs": { "no-var": { count: 2 } } }));
  assert.equal(qc().status, 2, "an untouched file with fewer findings fails");
  writeFileSync(baseline, JSON.stringify({ "src/gone.mjs": { "no-var": { count: 1 } } }));
  assert.equal(qc().status, 2, "a deleted file leaves a stale entry");
  writeFileSync(baseline, JSON.stringify({ "src/old.mjs": { "no-console": { count: 1 } } }));
  assert.equal(qc().status, 2, "a different rule cannot consume the count");
});

test("a staged baseline and source survive unstaged edits and deletion", (t) => {
  const { root, git, qc } = repo(t);
  const source = path.join(root, "src", "old.mjs");
  const baseline = path.join(root, "eslint-suppressions.json");
  writeFileSync(source, "var legacy = 2;\nexport const kept = legacy;\n");
  writeFileSync(baseline, JSON.stringify({ "src/old.mjs": { "no-var": { count: 1 } } }));
  git("add", "src/old.mjs", "eslint-suppressions.json");
  writeFileSync(source, "const legacy = 3;\nexport const kept = legacy;\n");
  writeFileSync(baseline, JSON.stringify({ "src/old.mjs": { "no-var": { count: 2 } } }));
  const edited = qc("--staged");
  assert.equal(edited.status, 0, edited.stderr);
  rmSync(source);
  const deleted = qc("--staged");
  assert.equal(deleted.status, 0, deleted.stderr);
});

test("qc lint catches a component inserted above an unchanged component", (t) => {
  const { root, git, qc } = repo(t);
  const require = createRequire(import.meta.url);
  const parser = pathToFileURL(require.resolve("@typescript-eslint/parser")).href;
  const plugin = new URL("../eslint/index.mjs", import.meta.url).href;
  writeFileSync(path.join(root, "eslint.config.mjs"), `
    import parser from ${JSON.stringify(parser)};
    import { rules } from ${JSON.stringify(plugin)};
    export default [{ files: ["**/*.tsx"], languageOptions: { parser }, plugins: { qc: { rules } }, rules: { "qc/one-component-per-file": "error" } }];
  `);
  const original = "export function Existing() { return <li />; }\n";
  writeFileSync(path.join(root, "src/view.tsx"), original);
  git("add", "eslint.config.mjs", "src/view.tsx");
  const commit = git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "test(qc): seed component");
  assert.equal(commit.status, 0, commit.stderr);
  writeFileSync(path.join(root, "src/view.tsx"), "const Added = () => <i />;\n" + original);
  const result = qc();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /src\/view\.tsx:1:7.*qc\/one-component-per-file/);
});
