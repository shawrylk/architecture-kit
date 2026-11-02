import assert from "node:assert/strict";
import test from "node:test";
import { watchedItems } from "./comment-watch.mjs";
import { PARSERS } from "./bash-command-guard.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

test("watch detection keeps closed issues, PR output, and body references", () => {
  const items = watchedItems({
    tool_name: "Bash",
    tool_input: { command: 'gh issue close 4 -R owner/repo; gh pr create --body "Fixes #5, #6"' },
    tool_response: { stdout: "https://github.com/owner/repo/pull/7" },
  }, "owner/repo", PARSERS.Bash);
  assert.deepEqual(items.map(({ repo, number }) => `${repo}#${number}`).sort(),
    ["owner/repo#4", "owner/repo#5", "owner/repo#6", "owner/repo#7"]);
});

test("PowerShell detects explicit repositories, body files, and commit references", (t) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "qc-comment-detection-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(path.join(cwd, "body.txt"), "Refs #8");
  for (const tool_name of ["Bash", "PowerShell"]) {
    const items = watchedItems({ cwd, tool_name, tool_input: {
      command: 'gh -R owner/other pr comment 3 --body-file body.txt; git commit -m "Fixes #9"',
    } }, "owner/repo");
    assert.deepEqual(items.map(({ repo, number }) => `${repo}#${number}`).sort(), ["owner/other#3", "owner/other#8", "owner/repo#9"]);
  }
});

function fixture(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "qc-comment-watch-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const args of [["init", "-q"], ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "fixture"], ["remote", "add", "origin", "https://github.com/shawrylk/example.git"]]) {
    assert.equal(spawnSync("git", args, { cwd }).status, 0);
  }
  const baseOid = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).stdout.trim();
  const mock = path.join(cwd, "mock.mjs");
  const data = path.join(cwd, "data.json");
  const calls = path.join(cwd, "calls.jsonl");
  writeFileSync(mock, `
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { appendFileSync, readFileSync } from 'node:fs';
    const original = cp.spawnSync;
    cp.spawnSync = (program, args, options) => {
      if (program === 'git' && args.join(' ') === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/shawrylk/example.git' };
      if (program !== 'gh') return original(program, args, options);
      appendFileSync(process.env.CALLS, JSON.stringify({args, config: options.env.GH_CONFIG_DIR}) + '\\n');
      const data = JSON.parse(readFileSync(process.env.DATA, 'utf8'));
      if (data.fail) return { status: 1, stderr: 'TOKEN_MUST_STAY_SECRET' };
      let result;
      if (args[0] === 'pr') result = { baseRefName: 'main', baseRefOid: data.baseOid, labels: [], number: 7, body: 'Fixes #4; https://github.com/ArentInc/other/issues/8' };
      else if (args[1] === 'user') result = { login: 'self' };
      else {
        const endpoint = args.at(-1);
        if (/issues\\/7$/.test(endpoint)) result = { pull_request: {} };
        else if (/issues\\/\\d+$/.test(endpoint)) result = {};
        else result = [data.rows.filter(row => endpoint.includes(row.endpoint)).map(({endpoint, ...row}) => row)];
      }
      return {status: 0, stdout: JSON.stringify(result)};
    };
    syncBuiltinESMExports();
  `);
  const row = (id, endpoint, login = "other") => ({ id, endpoint, user: { login }, body: `Comment ${id}`, html_url: `https://github.com/comments/${id}`, updated_at: "2026-01-01T00:00:00Z" });
  const rows = [row(1, "issues/4/comments"), row(2, "pulls/7/reviews"), row(3, "pulls/7/comments"), row(4, "issues/7/comments", "self"), row(5, "issues/8/comments")];
  const update = (extra = {}) => writeFileSync(data, JSON.stringify({ rows, baseOid, ...extra }));
  update();
  const run = (event, command = "", script = "comment-watch.mjs", session = "session-a") => {
    const cli = fileURLToPath(new URL(script, import.meta.url));
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(mock).href, cli], {
      cwd, encoding: "utf8", env: { ...process.env, DATA: data, CALLS: calls },
      input: JSON.stringify({ cwd, hook_event_name: event, session_id: session, tool_name: "PowerShell", tool_input: { command } }),
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  };
  return { cwd, rows, update, run, calls };
}

test("prompts show other authors once, retain failures, and isolate sessions and accounts", (t) => {
  const f = fixture(t);
  f.run("PostToolUse", "gh issue close 4");
  f.run("PostToolUse", "gh pr view 7");
  f.update({ fail: true });
  const note = JSON.stringify(f.run("UserPromptSubmit"));
  assert.match(note, /could not be checked/);
  assert.doesNotMatch(note, /TOKEN_MUST_STAY_SECRET/);
  f.update();
  const output = f.run("UserPromptSubmit").hookSpecificOutput.additionalContext;
  for (const id of [1, 2, 3, 5]) assert.match(output, new RegExp(`Comment ${id}`));
  assert.doesNotMatch(output, /Comment 4/);
  assert.equal(f.run("UserPromptSubmit"), null);
  f.rows.push({ ...f.rows[0], body: "Edited comment" });
  f.update();
  assert.match(JSON.stringify(f.run("UserPromptSubmit")), /Edited comment/);
  assert.equal(f.run("UserPromptSubmit", "", "comment-watch.mjs", "other-session"), null);
  const calls = readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(calls.some(call => call.args.some(arg => arg.includes("ArentInc/other")) && call.config === ""));
  assert.ok(calls.some(call => call.config === path.join(os.homedir(), ".config", "gh-personal")));
  writeFileSync(path.join(f.cwd, "qc.config.json"), JSON.stringify({ github: { configDirs: { shawrylk: "~/custom-gh" } } }));
  f.run("UserPromptSubmit");
  assert.match(readFileSync(f.calls, "utf8"), /custom-gh/);
  writeFileSync(path.join(f.cwd, "qc.config.json"), JSON.stringify({ commentWatch: false }));
  f.update({ fail: true });
  assert.equal(f.run("UserPromptSubmit"), null);
});

test("merge guard names unseen PR and linked issue comments until a prompt acknowledges them", (t) => {
  const f = fixture(t);
  const command = "gh pr merge 7 -R shawrylk/example";
  f.update({ fail: true });
  assert.match(f.run("PreToolUse", command, "merge-guard.mjs").hookSpecificOutput.permissionDecisionReason, /could not be checked/);
  f.update();
  const denied = f.run("PreToolUse", command, "merge-guard.mjs").hookSpecificOutput;
  assert.equal(denied.permissionDecision, "deny");
  for (const id of [1, 2, 3, 5]) assert.match(denied.permissionDecisionReason, new RegExp(`Comment ${id}`));
  assert.equal(f.run("PreToolUse", command, "merge-guard.mjs").hookSpecificOutput.permissionDecision, "deny");
  f.run("UserPromptSubmit");
  const passed = f.run("PreToolUse", command, "merge-guard.mjs");
  assert.notEqual(passed?.hookSpecificOutput?.permissionDecision, "deny");
  writeFileSync(path.join(f.cwd, "qc.config.json"), JSON.stringify({ commentWatch: false }));
  assert.notEqual(f.run("PreToolUse", command, "merge-guard.mjs", "other-session")?.hookSpecificOutput?.permissionDecision, "deny");
});
