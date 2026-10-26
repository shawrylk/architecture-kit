import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaults } from "../config.mjs";
import { checkDiff, protectedAllow, runCommitGuard, guardHead, checkRunCommits } from "./commit-guard.mjs";

const patch = (file, lines) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${lines}\n`;
const guard = (diff, options = {}) => checkDiff(diff, { protectedPaths: defaults.guard.protectedPaths, ...options });

test("only added secret lines fail; removed secrets and context pass", () => {
  const secret = `ghp_${"a".repeat(36)}`;
  assert.equal(guard(patch("src/a.mjs", `+${secret}`))[0].rule, "github-token");
  assert.deepEqual(guard(patch("src/a.mjs", `-${secret}\n ${secret}\n+safe`)), []);
  assert.deepEqual(guard(patch("src/a.mjs", `+${secret} qc-allow-secret`)), []);
});

test("only added start and end conflict markers fail", () => {
  for (const marker of ["<<<<<<< HEAD", ">>>>>>> branch"]) {
    assert.equal(guard(patch("src/a.mjs", `+${marker}`))[0].rule, "conflict-marker");
    assert.equal(guard(patch("src/a.mjs", `+${marker} qc-allow-secret`))[0].rule, "conflict-marker");
    assert.deepEqual(guard(patch("src/a.mjs", `-${marker}\n ${marker}\n+safe`)), []);
  }
  assert.deepEqual(guard(patch("src/a.mjs", "+=======\n+ <<<<<<< HEAD\n+<<<<<<<\n+>>>>>>>")), []);
});

test("each default protected path binds only the implementer", () => {
  for (const file of [".github/workflows/ci.yml", ".husky/pre-commit", ".githooks/pre-push", "qc.config.json", ".claude/settings.local.json"]) {
    const diff = patch(file, "+safe");
    assert.equal(guard(diff, { role: "implementer" })[0].rule, "protected-path");
    assert.deepEqual(guard(diff, { role: "reviewer" }), []);
    assert.deepEqual(guard(diff), []);
  }
});

test("explicit allow globs exempt protected paths, but still scan added lines", () => {
  const options = { role: "implementer", allow: [".github/workflows/**"] };
  assert.deepEqual(guard(patch(".github/workflows/a.yml", "+safe"), options), []);
  assert.equal(guard(patch(".github/workflows/a.yml", "+<<<<<<< HEAD"), options)[0].rule, "conflict-marker");
  assert.equal(guard(patch("qc.config.json", "+safe"), options)[0].rule, "protected-path");
});

test("Protected lines parse comma-separated globs without reading prose", () => {
  assert.deepEqual(protectedAllow("Paths: a\nProtected: .github/workflows/**, qc.config.json\nProtected: .husky/**\n"), [".github/workflows/**", "qc.config.json", ".husky/**"]);
  assert.deepEqual(protectedAllow("Do not use Protected: **\n"), []);
});

function repo(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-commit-guard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const globalConfig = path.join(root, "fixture-global-config");
  writeFileSync(globalConfig, "");
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" } });
  git("init", "-q");
  git("config", "user.name", "Guard Test");
  git("config", "user.email", "guard@example.test");
  const put = (file, content) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  const commit = () => { git("add", "--all"); git("commit", "-qm", "test: fixture"); };
  return { root, git, put, commit };
}

test("the hook guards every staged file before the source extension filter", () => {
  const hook = readFileSync(new URL("../../templates/githooks/pre-commit", import.meta.url), "utf8");
  const guard = hook.indexOf("npx qc commit-guard");
  assert.ok(guard > 0);
  assert.ok(guard < hook.indexOf("STAGED="));
});

test("the CLI scans the index, names each finding, and keeps secret values out of logs", (t) => {
  const r = repo(t);
  const secret = `ghp_${"a".repeat(36)}`;
  r.put("notes.md", `${secret}\n<<<<<<< HEAD\n>>>>>>> branch\n`);
  r.git("add", "notes.md");
  r.put("notes.md", "safe\n");
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./qc.mjs", import.meta.url)), "commit-guard"], { cwd: r.root, encoding: "utf8" });
  assert.equal(result.status, 4, result.stderr);
  for (const rule of ["github-token", "conflict-marker"]) assert.ok(result.stderr.includes(rule), result.stderr);
  assert.ok(result.stderr.includes("notes.md:1"));
  assert.ok(result.stderr.includes("notes.md:2"));
  assert.ok(result.stderr.includes("notes.md:3"));
  assert.ok(!result.stderr.includes(secret));
  r.git("add", "notes.md");
  r.put("notes.md", `${secret}\n`);
  assert.equal(runCommitGuard({ ...defaults, root: r.root }), 0);
});

test("staged protection covers deletions, renames, and binary files", (t) => {
  const r = repo(t);
  r.put("qc.config.json", "{}\n");
  r.put(".github/workflows/old.yml", "safe\n");
  r.commit();
  r.git("rm", "qc.config.json");
  r.git("mv", ".github/workflows/old.yml", "moved.yml");
  r.put(".husky/binary", Buffer.from([0, 1, 2]));
  r.git("add", "--all");
  const lines = [];
  const config = { ...defaults, root: r.root };
  const options = { env: { QC_ROLE: "implementer" }, say: (line) => lines.push(line) };
  assert.equal(runCommitGuard(config, options), 4);
  for (const file of ["qc.config.json", ".github/workflows/old.yml", ".husky/binary"]) assert.ok(lines.some((line) => line.includes(file)), lines.join("\n"));
  assert.equal(runCommitGuard(config, { env: {}, say: () => {} }), 0);
  assert.equal(runCommitGuard(config, { ...options, env: { QC_ROLE: "implementer", QC_PROTECTED_ALLOW: "qc.config.json, .github/workflows/**, .husky/**" } }), 0);
});

test("quoted paths and added diff headers retain their file and line numbers", (t) => {
  const r = repo(t);
  r.put("a spaced file.md", "+++ b/other.md\n<<<<<<< HEAD\n");
  r.git("add", "--all");
  const lines = [];
  assert.equal(runCommitGuard({ ...defaults, root: r.root }, { env: {}, say: (line) => lines.push(line) }), 4);
  assert.ok(lines[0].includes("a spaced file.md:2: conflict-marker"), lines.join("\n"));
  const diff = 'diff --git "a/a\\\"quote.md" "b/a\\\"quote.md"\n--- /dev/null\n+++ "b/a\\\"quote.md"\n@@ -0,0 +1 @@\n+<<<<<<< HEAD\n';
  assert.deepEqual(guard(diff), [{ path: 'a"quote.md', line: 1, rule: "conflict-marker" }]);
});

test("commit scans detect an intermediate secret removed by a later commit", (t) => {
  const r = repo(t);
  assert.equal(guardHead(r.root), null);
  r.put("a.md", "safe\n");
  r.commit();
  const before = guardHead(r.root);
  r.put("a.md", `ghp_${"a".repeat(36)}\n`);
  r.commit();
  const bad = guardHead(r.root);
  r.put("a.md", "safe\n");
  r.commit();
  assert.deepEqual(checkRunCommits(r.root, before, {}), [{ path: "a.md", line: 1, rule: "github-token", commit: bad }]);
  assert.deepEqual(checkRunCommits(r.root, guardHead(r.root), {}), []);
});

test("a root commit receives the same content checks", (t) => {
  const r = repo(t);
  r.put("first.md", ">>>>>>> branch\n");
  r.commit();
  const findings = checkRunCommits(r.root, null, {});
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "conflict-marker");
});

test("a merge excludes commits reached by the base branch", (t) => {
  const r = repo(t);
  r.put("base.md", "safe\n");
  r.commit();
  const before = guardHead(r.root);
  r.git("checkout", "-qb", "side");
  r.put("side.md", "<<<<<<< HEAD\n");
  r.commit();
  const bad = guardHead(r.root);
  r.put("side.md", "safe\n");
  r.commit();
  r.git("checkout", "-qb", "mainline", before);
  r.put("main.md", "safe\n");
  r.commit();
  r.git("merge", "--no-ff", "-qm", "test: merge fixture", "side");
  r.git("update-ref", "refs/remotes/origin/main", r.git("rev-parse", "side").trim());
  const findings = checkRunCommits(r.root, before, { base: "main" });
  assert.ok(!findings.some((finding) => finding.commit === bad && finding.rule === "conflict-marker"));
  assert.deepEqual(findings, []);
});

test("a base merge adds no protected paths to the run or staged guard", (t) => {
  const r = repo(t);
  r.put("base.md", "safe\n");
  r.commit();
  const before = guardHead(r.root);
  r.git("checkout", "-qb", "base");
  r.put(".github/workflows/ci.yml", "safe\n");
  r.commit();
  r.git("update-ref", "refs/remotes/origin/main", "HEAD");
  r.git("checkout", "-qb", "feature", before);
  r.put("feature.md", "safe\n");
  r.commit();
  r.git("merge", "--no-ff", "--no-commit", "base");
  const options = { role: "implementer", protectedPaths: defaults.guard.protectedPaths, base: "main" };
  assert.equal(runCommitGuard({ ...defaults, root: r.root }, { env: { QC_ROLE: "implementer" }, say: () => {} }), 0);
  r.git("commit", "-qm", "test: merge base");
  assert.deepEqual(checkRunCommits(r.root, before, options), []);
});

test("a merge scans its own secret resolution", (t) => {
  const r = repo(t);
  r.put("a.md", "base\n");
  r.commit();
  const before = guardHead(r.root);
  r.git("checkout", "-qb", "base");
  r.put("a.md", "base changed\n");
  r.commit();
  r.git("update-ref", "refs/remotes/origin/main", "HEAD");
  r.git("checkout", "-qb", "feature", before);
  r.put("a.md", "feature changed\n");
  r.commit();
  assert.throws(() => r.git("merge", "--no-commit", "base"));
  r.put("a.md", `ghp_${"a".repeat(36)}\n`);
  r.git("add", "a.md");
  assert.equal(runCommitGuard({ ...defaults, root: r.root }, { env: {}, say: () => {} }), 4);
  r.git("commit", "-qm", "test: resolve merge");
  const findings = checkRunCommits(r.root, before, { base: "main" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "github-token");
  assert.equal(findings[0].commit, guardHead(r.root));
});

test("a replaced commit boundary fails closed", (t) => {
  const r = repo(t);
  r.put("base.md", "safe\n");
  r.commit();
  const before = guardHead(r.root);
  r.put("base.md", "changed\n");
  r.git("add", "--all");
  r.git("commit", "--amend", "-qm", "test: replacement");
  assert.throws(() => checkRunCommits(r.root, before, {}));
});

test("the push guard scans intermediate pushed commits with the staged role rules", (t) => {
  const r = repo(t);
  r.put("base.md", "safe\n");
  r.commit();
  const before = guardHead(r.root);
  r.put(".github/workflows/ci.yml", `ghp_${"a".repeat(36)}\n`);
  r.commit();
  r.put(".github/workflows/ci.yml", "safe\n");
  r.commit();
  const head = guardHead(r.root);
  r.git("reset", "--hard", before);
  const lines = [];
  const argv = ["--push", head, before];
  const config = { ...defaults, root: r.root };
  assert.equal(runCommitGuard(config, { argv, env: { QC_ROLE: "implementer" }, say: (line) => lines.push(line) }), 4);
  assert.ok(lines.some((line) => line.includes("github-token")));
  assert.ok(lines.some((line) => line.includes("protected-path")));
  assert.equal(runCommitGuard(config, { argv, env: {}, say: () => {} }), 4);
  assert.equal(runCommitGuard(config, { argv: ["--push", head, head], env: {}, say: () => {} }), 0);
  assert.equal(runCommitGuard(config, { argv: ["--push", before, "0".repeat(40)], env: {}, say: () => {} }), 0);
  assert.equal(runCommitGuard(config, { argv: ["--push", "invalid", before], say: () => {} }), 4);
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL("./qc.mjs", import.meta.url)), "commit-guard", ...argv], { cwd: r.root, encoding: "utf8" });
  assert.equal(cli.status, 4, cli.stderr);
});

test("a clean protected push binds implementers and accepts explicit exceptions", (t) => {
  const r = repo(t);
  r.put("base.md", "safe\n");
  r.commit();
  const before = guardHead(r.root);
  r.put(".husky/config", "safe\n");
  r.commit();
  const argv = ["--push", guardHead(r.root), before];
  const config = { ...defaults, root: r.root };
  assert.equal(runCommitGuard(config, { argv, env: { QC_ROLE: "implementer" }, say: () => {} }), 4);
  assert.equal(runCommitGuard(config, { argv, env: {}, say: () => {} }), 0);
  assert.equal(runCommitGuard(config, { argv, env: { QC_ROLE: "reviewer" }, say: () => {} }), 0);
  assert.equal(runCommitGuard(config, { argv, env: { QC_ROLE: "implementer", QC_PROTECTED_ALLOW: ".husky/**" }, say: () => {} }), 0);
});

test("the pre-push template guards each nondeleted range before the full check", (t) => {
  const r = repo(t);
  const hook = readFileSync(new URL("../../templates/githooks/pre-push", import.meta.url), "utf8");
  const shell = process.platform === "win32" ? path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe") : "bash";
  r.put("pre-push", hook);
  r.put("bin/npx", '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$PUSH_LOG"\nif [ "$2" = commit-guard ]; then exit "${PUSH_GUARD_EXIT:-0}"; fi\n');
  chmodSync(path.join(r.root, "bin/npx"), 0o755);
  const zero = "0".repeat(40);
  const local = "a".repeat(40);
  const remote = "b".repeat(40);
  const log = path.join(r.root, "push-log");
  const invoke = (input, status = "0") => {
    writeFileSync(log, "");
    return spawnSync(shell, ["pre-push"], { cwd: r.root, input, encoding: "utf8", env: { ...process.env, PATH: `${path.join(r.root, "bin")}${path.delimiter}${process.env.PATH}`, PUSH_LOG: log, PUSH_GUARD_EXIT: status } });
  };
  let result = invoke(`refs/heads/a ${local} refs/heads/a ${remote}\nrefs/heads/b ${remote} refs/heads/b ${zero}\n(delete) ${zero} refs/heads/c ${remote}\n`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [`qc commit-guard --push ${local} ${remote}`, `qc commit-guard --push ${remote} ${zero}`, "qc check"]);
  result = invoke(`refs/heads/a ${local} refs/heads/a ${remote}\n`, "4");
  assert.equal(result.status, 4, result.stderr);
  assert.ok(!readFileSync(log, "utf8").includes("qc check"));
  result = invoke(`(delete) ${zero} refs/heads/a ${remote}\n`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(log, "utf8"), "");
});

test("all guard diffs use fixed prefixes and bypass external drivers", (t) => {
  const r = repo(t);
  r.git("config", "diff.noprefix", "true");
  r.git("config", "diff.mnemonicPrefix", "true");
  r.git("config", "diff.external", "guard-must-not-run-this-driver");
  r.put("ab/qc.config.json", "safe\n");
  r.git("add", "--all");
  const config = { ...defaults, root: r.root };
  assert.equal(runCommitGuard(config, { env: { QC_ROLE: "implementer" }, say: () => {} }), 0);
  r.commit();
  const before = guardHead(r.root);
  r.put("ab/notes.md", `ghp_${"a".repeat(36)}\n`);
  r.git("add", "--all");
  const lines = [];
  assert.equal(runCommitGuard(config, { env: {}, say: (line) => lines.push(line) }), 4);
  assert.ok(lines.some((line) => line.includes("ab/notes.md:1: github-token")), lines.join("\n"));
  r.commit();
  const findings = checkRunCommits(r.root, before, {});
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, "ab/notes.md");
  lines.length = 0;
  assert.equal(runCommitGuard(config, { argv: ["--push", guardHead(r.root), before], env: {}, say: (line) => lines.push(line) }), 4);
  assert.ok(lines.some((line) => line.includes("ab/notes.md:1: github-token")), lines.join("\n"));
});
