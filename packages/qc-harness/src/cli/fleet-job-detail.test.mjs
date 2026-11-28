import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DETAIL_LIMIT, buildJobDetail, capDetail, cleanDetail, detailLines, detailSummary, pushFailure, scrubDetailText } from "./fleet-job-detail.mjs";

const head = "7612386b1".padEnd(40, "0"), secret = "ab".repeat(32);
function jobDir(t, files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-detail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  let time = 1_000_000;
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), text);
    utimesSync(path.join(dir, name), time, time); time += 10;
  }
  return dir;
}
const gitWith = answers => async (_cwd, ...args) => {
  const answer = answers[args[0]];
  if (answer instanceof Error) throw answer;
  return { stdout: answer ?? "" };
};

test("detail holds the newest report tail, the newest progress tail, the head state and the push error", async t => {
  const dir = jobDir(t, {
    "implement-report.md": "old implement report",
    "implement-progress.md": "old progress",
    "fix-1-progress.md": `${"p".repeat(700)}\nnot ok 3 - saves the row\n`,
    "review-1-report.md": `${"r".repeat(2000)}\nVERDICT: CHANGES\n`,
    "implement.wrapper": "run 1\nAssertionError: expected 2, got 3\nerror: failed to push some refs to 'origin'\nexit 3\n",
    "loop.status": "STOP implement exit 3\n",
  });
  const git = gitWith({ "rev-parse": `${head}\n`, "rev-list": "2\n", "ls-remote": "" });
  const detail = await buildJobDetail({ row: { dir, worktree: dir, branch: "feat/job", base: "main" }, git, secret });
  assert.equal(detail.reportTail.length, 1500); assert.ok(detail.reportTail.endsWith("VERDICT: CHANGES"));
  assert.equal(detail.progressTail.length, 600); assert.ok(detail.progressTail.endsWith("not ok 3 - saves the row"));
  assert.deepEqual(detail.head, { commit: head, ahead: true, onOrigin: false });
  assert.ok(detail.pushError.endsWith("error: failed to push some refs to 'origin'")); assert.match(detail.pushError, /AssertionError: expected 2, got 3/);
  assert.equal(detailSummary(detail), "committed 7612386b1, not on origin");
});
test("a push error from the worker wins and is cut to its last 800 characters", async t => {
  const dir = jobDir(t, { "implement.wrapper": "error: failed to push some refs\n" });
  const detail = await buildJobDetail({ row: { dir }, git: gitWith({}), secret, pushError: `${"x".repeat(900)}\nhook says no` });
  assert.equal(detail.pushError.length, 800); assert.ok(detail.pushError.endsWith("hook says no"));
  assert.equal(detail.head, undefined);
  assert.equal(detailSummary({ pushError: "\nfirst line\nsecond line" }), "first line");
});
test("the head state shows a pushed commit, no new commit, and unknown when git fails", async () => {
  const row = { worktree: "w", branch: "feat/job", base: "main" };
  const pushed = await buildJobDetail({ row, git: gitWith({ "rev-parse": head, "rev-list": "1", "ls-remote": `${head}\trefs/heads/feat/job\n` }) });
  assert.equal(detailSummary(pushed), "committed 7612386b1, on origin");
  const stale = await buildJobDetail({ row, git: gitWith({ "rev-parse": head, "rev-list": "0", "ls-remote": `${"b".repeat(40)}\trefs/heads/feat/job\n` }) });
  assert.equal(detailSummary(stale), "no new commit, head 7612386b1, not on origin");
  const offline = await buildJobDetail({ row, git: gitWith({ "rev-parse": head, "rev-list": new Error("no base"), "ls-remote": new Error("offline") }) });
  assert.deepEqual(offline.head, { commit: head, ahead: null, onOrigin: null });
  assert.equal(detailSummary(offline), "head 7612386b1, origin unknown");
  assert.equal(await buildJobDetail({ row, git: gitWith({ "rev-parse": new Error("no worktree") }) }), undefined);
  assert.equal(await buildJobDetail({ row: { dir: path.join(os.tmpdir(), "qc-detail-absent") }, git: gitWith({}) }), undefined);
});
test("lines with --secret, token, password or Authorization are removed, and the fleet secret is hidden", async t => {
  const text = ["keep one", "run --secret abc", "GH_TOKEN=ghp_x", "Password: hunter2", "authorization: Bearer y", "AUTHORIZATION bearer z", `key ${secret.toUpperCase()}`, "keep two"].join("\n");
  assert.equal(scrubDetailText(text, secret), "keep one\nkey [REDACTED]\nkeep two");
  const dir = jobDir(t, { "implement-report.md": text, "implement-progress.md": text });
  const detail = await buildJobDetail({ row: { dir }, git: gitWith({}), secret, pushError: text });
  for (const key of ["reportTail", "progressTail", "pushError"]) assert.equal(detail[key], "keep one\nkey [REDACTED]\nkeep two");
  assert.doesNotMatch(JSON.stringify(detail), /hunter2|ghp_x|Bearer|bearer|abc/);
});
test("the whole detail is capped at 4000 characters and keeps the end of each text", () => {
  const big = { reportTail: `${"\n".repeat(3000)}report end`, progressTail: `${'"'.repeat(1500)}progress end`, pushError: `${"\\".repeat(1500)}push end`, head: { commit: head, ahead: true, onOrigin: false } };
  assert.ok(JSON.stringify(big).length > DETAIL_LIMIT);
  const capped = capDetail(big);
  assert.ok(JSON.stringify(capped).length <= DETAIL_LIMIT);
  assert.ok(capped.reportTail.endsWith("report end")); assert.ok(capped.progressTail.endsWith("progress end")); assert.ok(capped.pushError.endsWith("push end"));
  assert.deepEqual(capped.head, big.head);
  const small = { reportTail: "short" };
  assert.deepEqual(capDetail(small), small);
});
test("a detail from the wire keeps only known fields with valid types", () => {
  assert.equal(cleanDetail(undefined), undefined); assert.equal(cleanDetail("text"), undefined); assert.equal(cleanDetail([]), undefined);
  assert.equal(cleanDetail({ reportTail: 5, head: { commit: "short" }, command: "rm" }), undefined);
  assert.deepEqual(cleanDetail({ reportTail: "r".repeat(1600), progressTail: "token here", head: { commit: head, ahead: "yes", onOrigin: false }, command: "rm" }, secret),
    { reportTail: "r".repeat(1500), head: { commit: head, ahead: null, onOrigin: false } });
});
test("push failure text ends at the last failure line", () => {
  assert.equal(pushFailure("all good\nexit 0"), "");
  assert.equal(pushFailure("a\nhusky - pre-push script failed (code 1)\nb\n ! [rejected] feat -> feat (fetch first)\nlater"), "a\nhusky - pre-push script failed (code 1)\nb\n ! [rejected] feat -> feat (fetch first)");
});
test("detail lines print every stored part, and say so when a job has no detail", () => {
  const row = { id: "job", node: "b", state: "stopped", branch: "feat/worker", step: "STOP implement exit 3" };
  assert.match(detailLines(row).at(-1), /^detail: none/);
  const lines = detailLines({ ...row, reason: "why", detail: { reportTail: "report text", progressTail: "progress text", pushError: "push text", head: { commit: head, ahead: true, onOrigin: false } } });
  assert.deepEqual(lines, ["job b stopped feat/worker", "step: STOP implement exit 3", "reason: why", "summary: committed 7612386b1, not on origin", `head: ${head}`,
    "--- pushError", "push text", "--- progressTail", "progress text", "--- reportTail", "report text"]);
});
