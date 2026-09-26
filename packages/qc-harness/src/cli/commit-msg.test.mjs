import { strict as assert } from "node:assert";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaults } from "../config.mjs";
import { INSTALL_HINT, checkCommitMessage, loadCommitlint, runCommitMsg } from "./commit-msg.mjs";

// The harness package installs commitlint as a dev dependency, as an adopting repository would.
const HARNESS = fileURLToPath(new URL("../..", import.meta.url));
const TRAILER = "\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>\n";

function emptyDir(t) {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-commit-msg-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a conventional subject passes, and a subject that is not one fails with commitlint's rule", async () => {
  const commitlint = await loadCommitlint(HARNESS);
  assert.deepEqual(await checkCommitMessage("feat(cli): add qc pr-check\n", {}, commitlint), []);
  assert.deepEqual(await checkCommitMessage("feat(cli)!: drop the tools list\n", {}, commitlint), []);
  const rules = (await checkCommitMessage("Added some stuff\n", {}, commitlint)).map((problem) => problem.rule);
  assert.ok(rules.includes("conventional/type-empty"), rules.join());
});

test("a message that is not English fails, whatever commitlint says", async () => {
  const commitlint = await loadCommitlint(HARNESS);
  const problems = await checkCommitMessage("fix(ui): 写真を保存する\n", {}, commitlint);
  assert.deepEqual(problems.map((problem) => problem.rule), ["english"]);
});

test("with no commitlint installed, the check fails with the install command, unless conventional is off", async (t) => {
  const commitlint = await loadCommitlint(emptyDir(t));
  assert.equal(commitlint, null);
  const problems = await checkCommitMessage("feat: x\n", {}, commitlint);
  assert.deepEqual(problems.map((problem) => problem.rule), ["commitlint-missing"]);
  assert.ok(problems[0].detail.includes(INSTALL_HINT));
  assert.deepEqual(await checkCommitMessage("feat: x\n", { conventional: false }, null), []);
});

test("attribution is off by default, so a Claude trailer passes; on, a message without the trailer fails", async () => {
  const commitlint = await loadCommitlint(HARNESS);
  assert.equal(defaults.commitMessage.attribution, false);
  assert.deepEqual(await checkCommitMessage(`feat: x${TRAILER}`, defaults.commitMessage, commitlint), []);
  const on = { ...defaults.commitMessage, attribution: true };
  assert.deepEqual((await checkCommitMessage("feat: x\n", on, commitlint)).map((problem) => problem.rule), ["attribution"]);
  assert.deepEqual(await checkCommitMessage(`feat: x${TRAILER}`, on, commitlint), []);
});

test("qc commit-msg reads the file git wrote, and ignores its comment lines", async (t) => {
  const file = path.join(emptyDir(t), "COMMIT_EDITMSG");
  writeFileSync(file, "fix(hooks): read the installed harness\n# Please enter the commit message\n");
  const config = { root: HARNESS, commitMessage: defaults.commitMessage, language: {} };
  assert.equal(await runCommitMsg(config, file), 0);
  writeFileSync(file, "WIP\n");
  t.mock.method(console, "error", () => {});
  assert.equal(await runCommitMsg(config, file), 1);
});
