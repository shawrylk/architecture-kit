import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { appendRecord } from "./ledger.mjs";
import { decide } from "./worktree-gate.mjs";

const HOOK = fileURLToPath(new URL("./worktree-gate.mjs", import.meta.url));
const BRANCH = "feat/62-x";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

/** A main checkout with a pushed main, and a pushed branch in a worktree at `.worktree/kit-62`. */
function workspace(t, config = {}) {
  const top = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-worktree-gate-")));
  t.after(() => rmSync(top, { recursive: true, force: true }));
  const origin = path.join(top, "origin.git");
  const main = path.join(top, "main");
  const tmp = path.join(top, "tmp");
  mkdirSync(main);
  mkdirSync(tmp);
  git(top, "init", "-q", "--bare", "-b", "main", origin);
  git(main, "init", "-q", "-b", "main");
  for (const [key, value] of [["user.name", "qc"], ["user.email", "qc@example.com"], ["commit.gpgsign", "false"]]) git(main, "config", key, value);
  writeFileSync(path.join(main, ".gitignore"), ".worktree/\n");
  writeFileSync(path.join(main, "qc.config.json"), JSON.stringify(config));
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  git(main, "remote", "add", "origin", origin);
  git(main, "push", "-q", "-u", "origin", "main");
  const worktree = path.join(main, ".worktree", "kit-62");
  git(main, "worktree", "add", "-q", "-b", BRANCH, worktree);
  git(worktree, "push", "-q", "-u", "origin", BRANCH);
  const ledger = path.join(main, ".git", "qc", "ledger.jsonl");
  return { top, main, tmp, worktree, ledger };
}

const merge = (extra = {}) => ({ type: "merge", session: "s", pr: 60, repo: "o/r", sha: "abc1234", branch: BRANCH, base: "main", mergedAt: null, issues: [], ...extra });
const stopCall = (cwd, active = false) => ({ session_id: "s", cwd, hook_event_name: "Stop", stop_hook_active: active });
const gate = (ws, cwd = ws.main, active = false, projectDir = undefined) => decide(stopCall(cwd, active), { tmp: ws.tmp, projectDir });
const dropWorktree = (ws) => git(ws.main, "worktree", "remove", "--force", ws.worktree);
const dropBranch = (ws) => git(ws.main, "branch", "-D", BRANCH);
const dropRemote = (ws) => git(ws.main, "push", "-q", "origin", "--delete", BRANCH);

test("a merged PR whose worktree remains blocks the stop, and names qc worktree remove", (t) => {
  const ws = workspace(t);
  appendRecord(ws.ledger, merge());
  const output = gate(ws);
  assert.equal(output?.decision, "block");
  assert.match(output.reason, /o\/r#60 \(feat\/62-x\): `npx qc worktree remove kit-62`/);
  assert.match(output.reason, /from the main checkout/i);
});

test("a merged PR whose local branch remains blocks the stop, and names git branch -D", (t) => {
  const ws = workspace(t);
  appendRecord(ws.ledger, merge());
  dropWorktree(ws);
  dropRemote(ws);
  const output = gate(ws);
  assert.equal(output?.decision, "block");
  assert.match(output.reason, /`git branch -D feat\/62-x`/);
  assert.doesNotMatch(output.reason, /qc worktree remove|push origin --delete/);
});

test("a merged PR whose remote branch remains blocks the stop, and names git push origin --delete", (t) => {
  const ws = workspace(t);
  appendRecord(ws.ledger, merge());
  dropWorktree(ws);
  dropBranch(ws);
  const output = gate(ws);
  assert.equal(output?.decision, "block");
  assert.match(output.reason, /`git push origin --delete feat\/62-x`/);
  assert.doesNotMatch(output.reason, /branch -D/);
});

test("a merged PR with its worktree, its branch, and its remote branch gone passes", (t) => {
  const ws = workspace(t);
  appendRecord(ws.ledger, merge());
  dropWorktree(ws);
  dropBranch(ws);
  dropRemote(ws);
  assert.equal(gate(ws), null);
});

test("worktree.enforce false lets the stop pass with the worktree in place", (t) => {
  const ws = workspace(t, { worktree: { enforce: false } });
  appendRecord(ws.ledger, merge());
  assert.equal(gate(ws), null);
});

test("a merge of another session, a pending merge, a closed one, and a merge of a protected head pass", (t) => {
  const ws = workspace(t);
  appendRecord(ws.ledger, merge({ session: "other" }));
  appendRecord(ws.ledger, merge({ pending: true }));
  appendRecord(ws.ledger, merge({ closed: true }));
  appendRecord(ws.ledger, merge({ branch: "main", base: "release/1" }));
  assert.equal(gate(ws), null);
});

test("the main checkout on the merged branch is told to switch to the base first", (t) => {
  const ws = workspace(t);
  appendRecord(ws.ledger, merge());
  dropWorktree(ws);
  dropRemote(ws);
  git(ws.main, "switch", "-q", BRANCH);
  const output = gate(ws);
  assert.match(output.reason, /`git switch main`, then `git branch -D feat\/62-x`/);
});

test("a repeat stop with the same leftovers ends with a note, and a changed one blocks again", (t) => {
  const ws = workspace(t);
  appendRecord(ws.ledger, merge());
  assert.equal(gate(ws)?.decision, "block");
  const repeat = gate(ws, ws.main, true);
  assert.equal(repeat?.decision, undefined);
  assert.match(repeat.systemMessage, /same.*kit-62/s);
  dropWorktree(ws);
  dropRemote(ws);
  assert.equal(gate(ws, ws.main, true)?.decision, "block", "a changed text blocks again");
  dropBranch(ws);
  assert.equal(gate(ws, ws.main, true), null);
  assert.deepEqual(readdirSync(path.join(ws.tmp, "qc-worktree-gate")), [], "a clean stop forgets the last block");
});

test("a stop whose cwd is a removed worktree judges its main checkout, and one outside every checkout reads the project dir", (t) => {
  const ws = workspace(t);
  appendRecord(ws.ledger, merge());
  const gone = path.join(ws.main, ".worktree", "kit-61");
  assert.equal(gate(ws, gone)?.decision, "block");
  const outside = path.join(ws.top, "tmp");
  assert.equal(gate(ws, outside), null);
  assert.equal(gate(ws, outside, false, ws.main)?.decision, "block");
});

test("the hook process is silent in a checkout with no merge, and prints the block after one", (t) => {
  const ws = workspace(t);
  const run = () => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(stopCall(ws.main)),
    env: { ...process.env, TEMP: ws.tmp, TMP: ws.tmp, TMPDIR: ws.tmp, CLAUDE_PROJECT_DIR: "" },
    encoding: "utf8",
  });
  const quiet = run();
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, "");
  appendRecord(ws.ledger, merge());
  const blocked = run();
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).decision, "block");
  assert.ok(existsSync(ws.worktree));
});
