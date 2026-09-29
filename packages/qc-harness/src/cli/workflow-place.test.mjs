import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { commitLookup, firstUserText, nativePath, transcriptWorktree, workflowOfRepo, worktreeNamed } from "./workflow-place.mjs";

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

test("a linked worktree whose own config leaves the checks off does not take the primary checkout's workflow", (t) => {
  const { base, dir } = repo(t);
  writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {} } }));
  const linked = path.join(base, "linked");
  git(dir, "worktree", "add", "-q", "-b", "feat/x", linked);
  writeFileSync(path.join(linked, "qc.config.json"), JSON.stringify({ swarm: { toolCallBudget: 50 } }));
  assert.equal(workflowOfRepo(linked), null);
  assert.equal(workflowOfRepo(dir).root, dir);
});
