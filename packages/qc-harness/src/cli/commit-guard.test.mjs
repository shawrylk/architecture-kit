import { strict as assert } from "node:assert";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaults } from "../config.mjs";
import { checkDiff, protectedAllow, runCommitGuard, guardHead, guardRefs, checkRunCommits } from "./commit-guard.mjs";

const patch = (file, lines) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${lines}\n`;
const guard = (diff, options = {}) => checkDiff(diff, { protectedPaths: defaults.guard.protectedPaths, ...options });

function interceptGit(t, intercept) {
  const execute = childProcess.execFileSync;
  t.mock.method(childProcess, "execFileSync", (command, args, options) => intercept(command, args, options, execute));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

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

test("AWS operator assignments fail the guard with spaced and compact values", () => {
  const value = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  for (const name of ["AWS_SECRET_ACCESS_KEY", "aws_secret_access_key"]) {
    for (const separator of [":=", "?=", "+=", "!=", "-->", "=:=", "<-"]) {
      for (const spacing of ["", " ", "\t"]) {
        const line = `${name}${spacing}${separator}${spacing}${value}`;
        assert.deepEqual(guard(patch("Makefile", `+${line}`)), [{ path: "Makefile", line: 1, rule: "aws-secret-key" }]);
        assert.deepEqual(guard(patch("Makefile", `+${line} # qc-allow-secret`)), []);
        assert.deepEqual(guard(patch("Makefile", `-${line}\n safe`)), []);
      }
    }
  }
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

test("the run ignores sibling branches, detached worktrees, and fetched foreign refs", (t) => {
  const r = repo(t);
  r.put("base.md", "safe\n");
  r.commit();
  const branch = r.git("branch", "--show-current").trim();
  const before = guardRefs(r.root);
  for (const detached of [false, true]) {
    const worktree = path.join(r.root, detached ? "detached" : "sibling");
    r.git("worktree", "add", "-q", ...(detached ? ["--detach"] : ["-b", "other"]), worktree, before.head);
    writeFileSync(path.join(worktree, "qc.config.json"), "{}\n");
    r.git("-C", worktree, "add", "qc.config.json");
    r.git("-C", worktree, "commit", "-qm", "test: foreign change");
    r.git("update-ref", `refs/remotes/origin/foreign-${detached}`, r.git("-C", worktree, "rev-parse", "HEAD").trim());
  }
  assert.deepEqual(checkRunCommits(r.root, before, { branch, role: "implementer", protectedPaths: defaults.guard.protectedPaths }), []);
});

test("the run scans HEAD, its branch, and its remote branch even after a checkout", (t) => {
  const r = repo(t);
  r.put("base.md", "safe\n");
  r.commit();
  const before = guardRefs(r.root);
  const commits = [];
  for (const branch of ["run", "remote", "head"]) {
    r.git("checkout", "-qb", branch, before.head);
    r.put(`${branch}.md`, `ghp_${"a".repeat(36)}\n`);
    r.commit();
    commits.push(guardHead(r.root));
  }
  r.git("update-ref", "refs/remotes/origin/run", commits[1]);
  r.git("branch", "-D", "remote");
  assert.deepEqual(new Set(checkRunCommits(r.root, before, { branch: "run" }).map((finding) => finding.commit)), new Set(commits));
});

test("a moved local base cannot hide a run commit, even when the remote read fails", (t) => {
  const r = repo(t);
  r.put("base.md", "safe\n");
  r.commit();
  r.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const before = guardRefs(r.root, "main");
  r.put("secret.md", `ghp_${"a".repeat(36)}\n`);
  r.commit();
  const bad = guardHead(r.root);
  r.git("update-ref", "refs/remotes/origin/main", bad);
  assert.deepEqual(checkRunCommits(r.root, before, { base: "main" }).map((finding) => finding.commit), [bad]);
});

for (const redirect of ["url", "insteadOf"]) test(`a changed origin ${redirect} uses only the recorded base`, (t) => {
  const upstream = repo(t);
  upstream.put("base.md", "safe\n");
  upstream.commit();
  upstream.git("branch", "-M", "main");
  const r = repo(t);
  r.git("remote", "add", "origin", upstream.root);
  r.git("fetch", "-q", "origin");
  r.git("checkout", "-qfb", "run", "origin/main");
  const before = guardRefs(r.root);
  r.put("secret.md", `ghp_${"a".repeat(36)}\n`);
  r.commit();
  const bad = guardHead(r.root);
  r.git("update-ref", "refs/remotes/origin/main", bad);
  r.git("update-ref", "refs/heads/main", bad);
  r.git("config", "remote.origin.pushurl", upstream.root);
  if (redirect === "url") r.git("config", "remote.origin.url", ".");
  else r.git("config", `url.file:///${r.root.replace(/\\/g, "/")}/.insteadOf`, upstream.root);
  assert.deepEqual(checkRunCommits(r.root, before, { base: "main", branch: "run" }).map((finding) => finding.commit), [bad]);
});

for (const redirect of ["uploadpack", "sshCommand"]) test(`repository ${redirect} cannot redirect the recorded remote base`, (t) => {
  const upstream = repo(t);
  upstream.put("base.md", "safe\n");
  upstream.commit();
  upstream.git("branch", "-M", "main");
  const r = repo(t);
  const url = redirect === "uploadpack" ? upstream.root : "ssh://git@127.0.0.1:1/repo.git";
  r.git("remote", "add", "origin", url);
  r.git("fetch", "-q", upstream.root, "main:refs/remotes/origin/main");
  r.git("checkout", "-qfb", "run", "origin/main");
  const before = guardRefs(r.root);
  r.put("secret.md", `ghp_${"a".repeat(36)}\n`);
  r.commit();
  const bad = guardHead(r.root);
  r.git("update-ref", "refs/heads/main", bad);
  const self = r.root.replace(/\\/g, "/");
  if (redirect === "uploadpack") r.git("config", "remote.origin.uploadpack", `git-upload-pack '${self}' #`);
  else r.git("config", "core.sshCommand", `sh -c 'git-upload-pack "${self}"' --`);
  assert.equal(r.git("ls-remote", "--get-url", "origin").trim(), before.originUrl);
  assert.deepEqual(checkRunCommits(r.root, before, { base: "main", branch: "run" }).map((finding) => finding.commit), [bad]);
});

test("the remote base read uses its recorded URL outside the repository", (t) => {
  const r = repo(t);
  r.put("base.md", "safe\n");
  r.commit();
  r.git("remote", "add", "origin", r.root);
  const before = guardRefs(r.root);
  let remoteRead;
  interceptGit(t, (command, args, options, execute) => {
    if (args.includes("ls-remote") && !args.includes("--get-url")) remoteRead = { args, options };
    return execute(command, args, options);
  });
  assert.deepEqual(checkRunCommits(r.root, before, { base: "main" }), []);
  assert.ok(remoteRead);
  assert.ok(!remoteRead.args.includes("-C"));
  assert.deepEqual(remoteRead.args.slice(-3), ["ls-remote", before.originUrl, "refs/heads/main"]);
  assert.equal(remoteRead.options.cwd, os.tmpdir());
});

test("the remote base read matches the whole refname", (t) => {
  const r = repo(t);
  r.put("base.md", "safe\n");
  r.commit();
  r.git("branch", "-M", "main");
  r.git("remote", "add", "origin", r.root);
  r.git("update-ref", "refs/remotes/origin/main", "HEAD");
  r.git("checkout", "-qb", "run");
  const before = guardRefs(r.root);
  r.put("secret.md", `ghp_${"a".repeat(36)}\n`);
  r.commit();
  const bad = guardHead(r.root);
  r.git("update-ref", "refs/heads/a/refs/heads/main", bad);
  assert.deepEqual(checkRunCommits(r.root, before, { base: "main", branch: "run" }).map((finding) => finding.commit), [bad]);
});

for (const failure of ["ETIMEDOUT", "failure"]) test(`remote reads disable prompts, bound their time, and fall back on ${failure}`, (t) => {
  const r = repo(t);
  r.put("base.md", "safe\n");
  r.commit();
  r.git("remote", "add", "origin", r.root);
  r.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const calls = [];
  interceptGit(t, (command, args, options, execute) => {
    if (args.includes("ls-remote")) {
      calls.push({ args, options });
      if (!args.includes("--get-url")) throw Object.assign(new Error(failure), { code: failure });
    }
    return execute(command, args, options);
  });
  const before = guardRefs(r.root);
  r.put("secret.md", `ghp_${"a".repeat(36)}\n`);
  r.commit();
  const bad = guardHead(r.root);
  r.git("update-ref", "refs/remotes/origin/main", bad);
  assert.deepEqual(checkRunCommits(r.root, before, { base: "main" }).map((finding) => finding.commit), [bad]);
  assert.equal(calls.filter(({ args }) => args.includes("--get-url")).length, 2);
  assert.equal(calls.filter(({ args }) => !args.includes("--get-url")).length, 1);
  for (const { options } of calls) {
    assert.equal(options.timeout, 30_000);
    assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(options.env.GCM_INTERACTIVE, "never");
  }
});

test("failed origin URL reads use only the recorded tip", (t) => {
  const r = repo(t);
  r.put("base.md", "safe\n");
  r.commit();
  r.git("branch", "-M", "main");
  r.git("remote", "add", "origin", r.root);
  r.git("update-ref", "refs/remotes/origin/main", "HEAD");
  r.git("checkout", "-qb", "run");
  let remoteReads = 0;
  interceptGit(t, (command, args, options, execute) => {
    if (args.includes("ls-remote")) {
      if (args.includes("--get-url")) throw new Error("cannot read origin URL");
      remoteReads += 1;
    }
    return execute(command, args, options);
  });
  const before = guardRefs(r.root);
  r.put("secret.md", `ghp_${"a".repeat(36)}\n`);
  r.commit();
  const bad = guardHead(r.root);
  r.git("update-ref", "refs/heads/main", bad);
  r.git("update-ref", "refs/remotes/origin/main", bad);
  assert.deepEqual(checkRunCommits(r.root, before, { base: "main", branch: "run" }).map((finding) => finding.commit), [bad]);
  assert.equal(remoteReads, 0);
});

for (const platform of ["Windows", "POSIX"]) test(`a stalled ${platform} remote loses its transport process at the deadline`, {
  skip: platform === "Windows" ? process.platform !== "win32" : process.platform === "win32",
}, async (t) => {
  const server = spawn(process.execPath, ["--input-type=module", "-e", `
    import http from "node:http";
    const server = http.createServer((request) => request.socket.on("close", () => process.stdout.write("closed\\n")));
    server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));
  `], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  t.after(() => server.kill());
  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.stdout.once("data", (chunk) => resolve(Number(chunk.toString().trim())));
  });
  let timer;
  const closed = new Promise((resolve, reject) => {
    server.stdout.on("data", (chunk) => { if (chunk.toString().includes("closed")) resolve(); });
    timer = setTimeout(() => reject(new Error("the remote transport kept its socket open")), 10_000);
  });
  t.after(() => clearTimeout(timer));
  const r = repo(t);
  r.put("base.md", "safe\n");
  r.commit();
  r.git("remote", "add", "origin", `http://127.0.0.1:${port}/repo`);
  r.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const before = guardRefs(r.root);
  r.put("secret.md", `ghp_${"a".repeat(36)}\n`);
  r.commit();
  const bad = guardHead(r.root);
  interceptGit(t, (command, args, options, execute) => {
    if (args.includes("ls-remote") && !args.includes("--get-url")) {
      assert.equal(command, process.execPath);
      return execute(command, args.map((word) => word === "29000" ? "1000" : word), options);
    }
    return execute(command, args, options);
  });
  const started = Date.now();
  assert.deepEqual(checkRunCommits(r.root, before, { base: "main" }).map((finding) => finding.commit), [bad]);
  assert.ok(Date.now() - started < 5000);
  await closed;
});

test("a confirmed remote base excludes a merge even when its local tracking ref is stale", (t) => {
  const upstream = repo(t);
  upstream.put("base.md", "safe\n");
  upstream.commit();
  upstream.git("branch", "-M", "main");
  const r = repo(t);
  r.git("remote", "add", "origin", upstream.root);
  r.git("fetch", "-q", "origin");
  r.git("checkout", "-qfb", "run", "origin/main");
  const before = guardRefs(r.root, "main");
  upstream.put("qc.config.json", "{}\n");
  upstream.commit();
  r.git("fetch", "-q", "origin");
  r.git("merge", "-q", "origin/main");
  r.git("update-ref", "refs/remotes/origin/main", before.head);
  assert.deepEqual(checkRunCommits(r.root, before, { base: "main", branch: "run", role: "implementer", protectedPaths: defaults.guard.protectedPaths }), []);
});

test("a large recorded boundary and tree tags reach rev-list without a long command line", (t) => {
  const r = repo(t);
  r.put("base.md", "safe\n");
  r.commit();
  r.git("tag", "tree", "HEAD^{tree}");
  const before = guardRefs(r.root);
  before.refs.push(...Array(900).fill(before.head));
  r.put("secret.md", `ghp_${"a".repeat(36)}\n`);
  r.commit();
  assert.deepEqual(checkRunCommits(r.root, before, {}).map((finding) => finding.rule), ["github-token"]);
});

test("rev-list receives only deduplicated refs and exclusions on stdin", (t) => {
  const r = repo(t);
  r.put("base.md", "safe\n");
  r.commit();
  const before = guardRefs(r.root);
  r.put("new.md", "safe\n");
  r.commit();
  let calls = 0;
  interceptGit(t, (command, args, options, execute) => {
    if (args.includes("rev-list")) {
      calls += 1;
      assert.deepEqual(args.slice(4), ["rev-list", "--reverse", "--parents", "--stdin"]);
      const lines = options.input.trim().split("\n");
      assert.equal(lines.length, new Set(lines).size);
      assert.ok(lines.includes(`^${before.head}`));
      assert.ok(!args.includes("--all"));
    }
    return execute(command, args, options);
  });
  assert.deepEqual(checkRunCommits(r.root, before, {}), []);
  assert.equal(calls, 1);
});

test("a merge excludes commits reached by the base branch", (t) => {
  const r = repo(t);
  r.put("base.md", "safe\n");
  r.commit();
  r.git("remote", "add", "origin", r.root);
  const before = guardRefs(r.root);
  r.git("checkout", "-qb", "side");
  r.put("side.md", "<<<<<<< HEAD\n");
  r.commit();
  const bad = guardHead(r.root);
  r.put("side.md", "safe\n");
  r.commit();
  r.git("checkout", "-qb", "mainline", before.head);
  r.put("main.md", "safe\n");
  r.commit();
  r.git("merge", "--no-ff", "-qm", "test: merge fixture", "side");
  r.git("update-ref", "refs/remotes/origin/main", r.git("rev-parse", "side").trim());
  r.git("update-ref", "refs/heads/main", r.git("rev-parse", "side").trim());
  const findings = checkRunCommits(r.root, before, { base: "main" });
  assert.ok(!findings.some((finding) => finding.commit === bad && finding.rule === "conflict-marker"));
  assert.deepEqual(findings, []);
});

test("a deleted side branch's intermediate secret stays in the run scan", (t) => {
  const r = repo(t);
  r.put("base.md", "safe\n");
  r.commit();
  r.git("branch", "-M", "run");
  r.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const before = guardRefs(r.root);
  r.git("checkout", "-qb", "side");
  r.put("side.md", `ghp_${"a".repeat(36)}\n`);
  r.commit();
  const bad = guardHead(r.root);
  r.put("side.md", "safe\n");
  r.commit();
  r.git("checkout", "-q", "run");
  r.put("run.md", "safe\n");
  r.commit();
  r.git("merge", "--no-ff", "-qm", "test: merge side", "side");
  r.git("branch", "-D", "side");
  assert.deepEqual(checkRunCommits(r.root, before, { branch: "run" }), [{ path: "side.md", line: 1, rule: "github-token", commit: bad }]);
});

test("merge scans select remerge from git 2.36 and combined diffs on older git, with one version read", async (t) => {
  const r = repo(t);
  r.put("a.md", "base\n");
  r.commit();
  r.git("remote", "add", "origin", r.root);
  const before = guardRefs(r.root);
  r.git("checkout", "-qb", "base");
  r.put("a.md", "base changed\n");
  r.put(".github/workflows/base.yml", "safe\n");
  r.commit();
  r.git("update-ref", "refs/heads/main", "HEAD");
  r.git("checkout", "-qb", "run", before.head);
  r.put("a.md", "run changed\n");
  r.commit();
  assert.throws(() => r.git("merge", "--no-commit", "base"));
  r.put("a.md", `resolved\nghp_${"a".repeat(36)}\n`);
  r.put(".github/workflows/merge.yml", "safe\n");
  r.commit();
  const merge = guardHead(r.root);
  let version;
  let reads;
  interceptGit(t, (command, args, options, execute) => {
    if (args.includes("--version")) { reads += 1; return `git version ${version}\n`; }
    if (args.includes("show")) {
      const isMerge = args.includes(merge);
      assert.equal(args.includes("--diff-merges=remerge"), isMerge && version !== "2.35.9");
      assert.equal(args.includes("--cc"), isMerge && version === "2.35.9");
    }
    return execute(command, args, options);
  });
  for (version of ["2.35.9", "2.36.0", "2.54.0.windows.1"]) {
    reads = 0;
    const guardModule = await import(`./commit-guard.mjs?version=${version}`);
    const findings = guardModule.checkRunCommits(r.root, before, { branch: "run", base: "main", role: "implementer", protectedPaths: defaults.guard.protectedPaths });
    assert.deepEqual(findings, [
      { path: "a.md", line: 2, rule: "github-token", commit: merge },
      { path: ".github/workflows/merge.yml", rule: "protected-path", commit: merge },
    ]);
    const lines = [];
    assert.equal(guardModule.runCommitGuard({ ...defaults, root: r.root }, { argv: ["--push", merge, before.head], env: {}, say: (line) => lines.push(line) }), 4);
    assert.ok(lines.some((line) => line.includes("github-token")), lines.join("\n"));
    assert.equal(reads, 1);
  }
});

test("a clean merge's own secret and protected file are scanned", (t) => {
  const r = repo(t);
  r.put("base.md", "safe\n");
  r.commit();
  const before = guardRefs(r.root);
  r.git("checkout", "-qb", "side");
  r.put("side.md", "safe\n");
  r.commit();
  r.git("checkout", "-qb", "run", before.head);
  r.put("run.md", "safe\n");
  r.commit();
  r.git("merge", "--no-ff", "--no-commit", "side");
  r.put("base.md", `safe\nghp_${"a".repeat(36)}\n`);
  r.put(".github/workflows/merge.yml", "safe\n");
  r.commit();
  const findings = checkRunCommits(r.root, before, { branch: "run", role: "implementer", protectedPaths: defaults.guard.protectedPaths });
  assert.ok(findings.some((finding) => finding.rule === "github-token" && finding.commit === guardHead(r.root)));
  assert.ok(findings.some((finding) => finding.rule === "protected-path" && finding.commit === guardHead(r.root)));
});

test("a base merge adds no protected paths to the run or staged guard", (t) => {
  const r = repo(t);
  r.put("base.md", "safe\n");
  r.commit();
  r.git("remote", "add", "origin", r.root);
  const before = guardRefs(r.root);
  r.git("checkout", "-qb", "base");
  r.put(".github/workflows/ci.yml", "safe\n");
  r.commit();
  r.git("update-ref", "refs/remotes/origin/main", "HEAD");
  r.git("checkout", "-qb", "feature", before.head);
  r.git("update-ref", "refs/heads/main", r.git("rev-parse", "base").trim());
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
  r.git("remote", "add", "origin", r.root);
  r.git("update-ref", "refs/heads/main", r.git("rev-parse", "base").trim());
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
