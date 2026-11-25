import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCodexRecovery } from "./codex-recovery.mjs";

test("fixed restoration freezes admission/path/freshness and bounds escaped output", t => {
  const worktree = realpathSync(mkdtempSync(path.join(os.tmpdir(), "qc-recovery-")));
  t.after(() => rmSync(worktree, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const repository = path.join(worktree, ".git"), directory = path.join(repository, "qc", "checkpoints");
  mkdirSync(directory, { recursive: true });
  const authority = { worktree, repository, nativeThreadId: "thread", role: "reviewer" };
  const settings = { maxAgeMinutes: 2 }, restore = createCodexRecovery(authority, settings);
  authority.nativeThreadId = "sibling"; authority.worktree = os.tmpdir(); settings.maxAgeMinutes = 0;
  const file = path.join(directory, "thread.md"), header = "## Goal\n## Rules\n## Tasks\n## Next\n";
  const text = header + "\u0000".repeat(8192 - Buffer.byteLength(header));
  writeFileSync(file, text);
  const output = restore();
  assert.equal(output.hookSpecificOutput.additionalContext, text);
  assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, output })) < 65536);
  writeFileSync(file, header + "updated marker");
  assert.equal(restore().hookSpecificOutput.additionalContext, header + "updated marker");
  const old = new Date(Date.now() - 3 * 60000); utimesSync(file, old, old);
  assert.throws(restore, /unavailable/);
  for (const maxAgeMinutes of [-1, NaN, Infinity]) assert.throws(() => createCodexRecovery(
    { ...authority, worktree, nativeThreadId: "thread" }, { maxAgeMinutes }), /unavailable/);
});
