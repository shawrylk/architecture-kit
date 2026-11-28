import assert from "node:assert/strict";
import { test } from "node:test";
import { GIT_BUFFER_BYTES, LONG_GIT_MS, SHORT_GIT_MS, gitLimits } from "./fleet-git.mjs";

test("git calls that can run a repo hook get the long bound and a large buffer", () => {
  for (const args of [["worktree", "add", "-b", "feat/x", "/tmp/x", "origin/main"],
    ["-c", "core.ignoreStat=false", "worktree", "add", "--detach", "/tmp/x", "a".repeat(40)],
    ["push", "-u", "origin", "feat/x"], ["commit", "-m", "x"], ["checkout", "main"]]) {
    assert.deepEqual(gitLimits(args), { timeout: LONG_GIT_MS, maxBuffer: GIT_BUFFER_BYTES }, args.join(" "));
  }
  assert.equal(LONG_GIT_MS, 20 * 60_000);
});

test("fast git calls keep the short bound", () => {
  for (const args of [["fetch", "origin", "main"], ["rev-parse", "HEAD"], ["ls-remote", "--heads", "origin", "refs/heads/x"],
    ["worktree", "remove", "--force", "/tmp/x"], ["-c", "core.ignoreStat=false", "status", "--porcelain"]]) {
    assert.equal(gitLimits(args).timeout, SHORT_GIT_MS, args.join(" "));
  }
});
