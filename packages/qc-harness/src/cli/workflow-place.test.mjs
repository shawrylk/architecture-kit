import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { commitLookup, firstUserText, nativePath, resolveNamedWorktree, transcriptWorktree, workflowOfRepo, worktreeNamed } from "./workflow-place.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

function repo(t) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-place-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, "repo");
  git(base, "init", "-q", "-b", "main", dir);
  writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", ".");
  git(dir, "-c", "user.name=qc", "-c", "user.email=qc@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
  return { base, dir, head: git(dir, "rev-parse", "HEAD") };
}

test("a Git Bash drive path becomes a Windows path on win32 only", () => {
  assert.equal(nativePath("/c/Users/a b/wt", "win32"), "c:/Users/a b/wt");
  assert.equal(nativePath("/D/x", "win32"), "D:/x");
  assert.equal(nativePath("/c", "win32"), "c:/");
  assert.equal(nativePath("C:/Users/x", "win32"), "C:/Users/x");
  assert.equal(nativePath("/cygdrive/x", "win32"), "/cygdrive/x");
  assert.equal(nativePath("/c/Users/x", "linux"), "/c/Users/x");
});

test("the worktree line is read exactly", () => {
  assert.equal(worktreeNamed("x\n  Worktree:  C:/a b/wt  \ny"), "C:/a b/wt");
  assert.equal(worktreeNamed("the worktree is /tmp/wt"), null);
});

test("commitLookup tells a found commit from an unknown sha from a git failure", (t) => {
  const { dir, head } = repo(t);
  assert.deepEqual(commitLookup(dir, head.slice(0, 8)), { sha: head });
  assert.deepEqual(commitLookup(dir, "deadbee"), { unknown: true });
  assert.match(commitLookup(path.join(dir, "..", "no-such-dir"), head).error ?? "", /./);
  const timedOut = () => ({ status: null, error: Object.assign(new Error("x"), { code: "ETIMEDOUT" }) });
  assert.match(commitLookup(dir, head, { timeoutMs: 5, run: timedOut }).error ?? "", /timed out/);
});

test("commitLookup reports a spawn error, a signal, and a fatal exit as a failure", () => {
  const failing = (over) => () => ({ status: null, stdout: "", stderr: "", ...over });
  assert.match(commitLookup("x", "abc1234", { run: failing({ error: Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }) }) }).error ?? "", /ENOENT/);
  assert.match(commitLookup("x", "abc1234", { run: failing({ signal: "SIGTERM" }) }).error ?? "", /SIGTERM/);
  assert.match(commitLookup("x", "abc1234", { run: failing({ status: 128, stderr: "fatal: not a git repository" }) }).error ?? "", /not a git repository/);
  assert.deepEqual(commitLookup("x", "abc1234", { run: failing({ status: 1 }) }), { unknown: true });
  assert.deepEqual(commitLookup("x", "abc1234", { run: failing({ status: 0, stdout: `${"a".repeat(40)}\n` }) }), { sha: "a".repeat(40) });
});

test("the first user message of a transcript names the worktree, whatever the content shape", (t) => {
  const { base } = repo(t);
  const write = (name, ...records) => {
    const file = path.join(base, name);
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    return file;
  };
  const user = (content) => ({ type: "user", isSidechain: true, message: { role: "user", content } });
  const later = user("Worktree: C:/later/wt");
  const text = write("a.jsonl", { type: "summary" }, user("Read the brief.\nWorktree: C:/one/wt\nGo."), later);
  assert.equal(firstUserText(text), "Read the brief.\nWorktree: C:/one/wt\nGo.");
  assert.equal(transcriptWorktree(text), "C:/one/wt");
  const blocks = write("b.jsonl", user([{ type: "text", text: "Read." }, { type: "text", text: "Worktree: C:/two/wt" }]));
  assert.equal(transcriptWorktree(blocks), "C:/two/wt");
  assert.equal(transcriptWorktree(write("c.jsonl", user("No worktree here."))), null);
  assert.equal(transcriptWorktree(path.join(base, "missing.jsonl")), null);
  assert.equal(transcriptWorktree(undefined), null);
  const junk = path.join(base, "d.jsonl");
  writeFileSync(junk, "not json\n");
  assert.equal(transcriptWorktree(junk), null);
});

test("a transcript's first message is read even when the file is large", (t) => {
  const { base } = repo(t);
  const file = path.join(base, "big.jsonl");
  const first = { type: "user", message: { role: "user", content: "Worktree: C:/big/wt" } };
  writeFileSync(file, `${JSON.stringify(first)}\n${"x".repeat(2 * 1024 * 1024)}\n`);
  assert.equal(transcriptWorktree(file), "C:/big/wt");
});

test("a linked worktree cut before the config existed takes the workflow of its primary checkout", (t) => {
  const { base, dir } = repo(t);
  const linked = path.join(base, "linked");
  git(dir, "worktree", "add", "-q", "-b", "feat/x", linked);
  assert.equal(workflowOfRepo(linked), null, "no config anywhere, so the checks are off");
  writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {} } }));
  const workflow = workflowOfRepo(linked);
  assert.equal(workflow.root, dir);
  assert.equal(workflow.ledger, path.join(dir, ".git", "qc", "ledger.jsonl"));
});

test("a Worktree line ends its path before a parenthetical", () => {
  assert.equal(worktreeNamed("Worktree: C:/x/kit-47 (branch feat/47-y)"), "C:/x/kit-47");
  assert.equal(worktreeNamed('Worktree: "C:/a b/wt" (branch x)'), "C:/a b/wt");
  assert.equal(worktreeNamed("Worktree: 'C:/a b/wt'  (branch x)\nmore"), "C:/a b/wt");
  assert.equal(worktreeNamed("Worktree: C:/a b/wt"), "C:/a b/wt");
});

test("resolveNamedWorktree takes the path that exists: the cut path, the whole line, or the longest prefix", (t) => {
  const { base } = repo(t);
  const plain = path.join(base, "kit-47").replaceAll(String.fromCharCode(92), "/");
  const spaced = path.join(base, "Prog Files (x86)", "wt").replaceAll(String.fromCharCode(92), "/");
  for (const dir of [plain, spaced]) mkdirSync(dir, { recursive: true });
  const found = (line) => resolveNamedWorktree(`Read the brief.\nWorktree: ${line}\nGo.`, base);
  assert.deepEqual([found(`${plain} (branch feat/47-y)`).found, found(`${plain} (branch feat/47-y)`).abs], [true, path.resolve(plain)]);
  assert.equal(found(spaced).abs, path.resolve(spaced), "a parenthesis inside the path");
  assert.equal(found(`${plain} on branch feat/47-y`).abs, path.resolve(plain), "the longest prefix that exists");
  const missing = found(`${path.join(base, "nowhere").replaceAll(String.fromCharCode(92), "/")} (branch x)`);
  assert.equal(missing.found, false);
  assert.equal(missing.spelled, path.join(base, "nowhere").replaceAll(String.fromCharCode(92), "/"));
  assert.equal(resolveNamedWorktree("no worktree line", base), null);
});

test("the workflow of a repository comes from its primary checkout, whatever a linked worktree's own config says", (t) => {
  const { base, dir } = repo(t);
  writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {} } }));
  const linked = path.join(base, "linked");
  git(dir, "worktree", "add", "-q", "-b", "feat/x", linked);
  writeFileSync(path.join(linked, "qc.config.json"), JSON.stringify({ swarm: { toolCallBudget: 50 } }));
  assert.equal(workflowOfRepo(linked).root, dir, "an edit of qc.config.json in a worktree cannot turn the checks off");
  assert.equal(workflowOfRepo(dir).root, dir);
});

test("a worktree's own config decides only when the primary checkout has none", (t) => {
  const { base, dir } = repo(t);
  const linked = path.join(base, "linked");
  git(dir, "worktree", "add", "-q", "-b", "feat/x", linked);
  writeFileSync(path.join(linked, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {} } }));
  assert.equal(workflowOfRepo(linked).root, linked);
});

test("a checkout that shares the cwd workflow's git common dir uses the cwd workflow itself", (t) => {
  const { base, dir } = repo(t);
  writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {} } }));
  const linked = path.join(base, "linked");
  git(dir, "worktree", "add", "-q", "-b", "feat/x", linked);
  const own = workflowOfRepo(dir);
  assert.equal(workflowOfRepo(linked, own), own);
  const otherDir = path.join(base, "other");
  git(base, "init", "-q", "-b", "main", otherDir);
  writeFileSync(path.join(otherDir, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {} } }));
  assert.equal(workflowOfRepo(otherDir, own).root, otherDir);
});
