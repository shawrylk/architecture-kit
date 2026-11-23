import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { watchedItems } from "./comment-watch.mjs";
import { PARSERS } from "./bash-command-guard.mjs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
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
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(cwd, "empty-gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0" };
  delete env.GH_CONFIG_DIR;
  writeFileSync(env.GIT_CONFIG_GLOBAL, "");
  for (const args of [["init", "-q"], ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "fixture"], ["remote", "add", "origin", "https://github.com/shawrylk/example.git"]]) {
    assert.equal(spawnSync("git", args, { cwd, env }).status, 0);
  }
  const baseOid = spawnSync("git", ["rev-parse", "HEAD"], { cwd, env, encoding: "utf8" }).stdout.trim();
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
      if (data.fail || args.some(arg => arg.includes(data.failEndpoint ?? 'NEVER_MATCH'))) return { status: 1, stderr: 'TOKEN_MUST_STAY_SECRET' };
      if (args[0] === 'api' && args[1].includes('/git/ref/heads/') && args.at(-2) === '--jq' && args.at(-1) === '.object.sha') return { status: 0, stdout: data.baseOid };
      let result;
      if (args[0] === 'pr') result = { baseRefName: 'main', baseRefOid: data.baseOid, labels: [], number: 7, body: data.body ?? 'Fixes #4; https://github.com/ArentInc/other/issues/8', commits: data.commits ?? [] };
      else if (args[1] === 'user') result = { login: 'self' };
      else if (args[1] === 'graphql') result = { data: { node: { number: 7, repository: { nameWithOwner: 'shawrylk/example' } } } };
      else {
        const endpoint = args.at(-1);
        if (/issues\\/7$/.test(endpoint)) result = { pull_request: {} };
        else if (/issues\\/\\d+$/.test(endpoint)) result = {};
        else result = [[], data.rows.filter(row => endpoint.includes(row.endpoint)).map(({endpoint, ...row}) => row)];
      }
      return {status: 0, stdout: args.includes('--paginate') ? result.map(page => JSON.stringify(page)).join('\\n') : JSON.stringify(result)};
    };
    cp.execFile = (program, args, options, callback) => {
      const data = JSON.parse(readFileSync(process.env.DATA, 'utf8'));
      appendFileSync(process.env.CALLS, JSON.stringify({ start: Date.now(), args, config: options.env.GH_CONFIG_DIR }) + '\\n');
      const result = cp.spawnSync(program, args, options);
      setTimeout(() => callback(result.status ? new Error('gh failed') : null, result.stdout, result.stderr), data.delay ?? 0);
    };
    syncBuiltinESMExports();
  `);
  const row = (id, endpoint, login = "other") => ({ id, endpoint, user: { login }, body: `Comment ${id}`, html_url: `https://github.com/comments/${id}`, updated_at: "2026-01-01T00:00:00Z" });
  const rows = [row(1, "issues/4/comments"), row(2, "pulls/7/reviews"), row(3, "pulls/7/comments"), row(4, "issues/7/comments", "self"), row(5, "issues/8/comments")];
  const update = (extra = {}) => writeFileSync(data, JSON.stringify({ rows, baseOid, ...extra }));
  update();
  const run = (event, command = "", script = "comment-watch.mjs", session = "session-a", tool_response = "", tool_name = "PowerShell", parentCwd = cwd) => {
    const cli = fileURLToPath(new URL(script, import.meta.url));
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(mock).href, cli], {
      cwd: parentCwd, encoding: "utf8", env: { ...env, DATA: data, CALLS: calls },
      input: JSON.stringify({ cwd, hook_event_name: event, session_id: session, tool_name, tool_response, tool_input: { command } }),
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  };
  return { cwd, rows, update, run, calls };
}

for (const exists of [false, true]) {
  test(`a mapped config folder that ${exists ? "exists sets GH_CONFIG_DIR" : "does not exist leaves GH_CONFIG_DIR unset"}`, (t) => {
    const f = fixture(t);
    const folder = path.join(f.cwd, "gh-config");
    if (exists) mkdirSync(folder);
    writeFileSync(path.join(f.cwd, "qc.config.json"), JSON.stringify({ github: { configDirs: { shawrylk: `~/${path.relative(os.homedir(), folder).split(path.sep).join("/")}` } } }));
    f.run("PostToolUse", "gh pr view 7");
    f.run("UserPromptSubmit");
    const calls = readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse);
    const mapped = calls.filter(call => call.args.some(arg => arg.includes("shawrylk/example")));
    assert.ok(mapped.length > 0);
    for (const call of mapped) assert.equal(call.config, exists ? folder : undefined);
    const unmapped = calls.filter(call => call.args.some(arg => arg.includes("ArentInc/other")));
    assert.ok(unmapped.length > 0);
    for (const call of unmapped) assert.equal(call.config, undefined);
  });
}

test("a relative mapped config folder is checked against the checkout root", (t) => {
  for (const existsInRoot of [true, false]) {
    const f = fixture(t);
    const parent = mkdtempSync(path.join(os.tmpdir(), "qc-comment-parent-"));
    t.after(() => rmSync(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
    mkdirSync(path.join(existsInRoot ? f.cwd : parent, "packages"));
    writeFileSync(path.join(f.cwd, "qc.config.json"), JSON.stringify({ github: { configDirs: { shawrylk: "packages" } } }));
    const parentCwd = existsInRoot ? path.parse(f.cwd).root : parent;
    f.run("PostToolUse", "gh pr view 7", "comment-watch.mjs", "session-a", "", "PowerShell", parentCwd);
    f.run("UserPromptSubmit", "", "comment-watch.mjs", "session-a", "", "PowerShell", parentCwd);
    const calls = readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse);
    const mapped = calls.filter(call => call.args.some(arg => arg.includes("shawrylk/example")));
    assert.ok(mapped.length > 0);
    for (const call of mapped) assert.equal(call.config, existsInRoot ? "packages" : undefined);
  }
});

test("prompts show shared-login feedback once, retain failures, and isolate sessions and accounts", (t) => {
  const f = fixture(t);
  const folder = path.join(f.cwd, "gh-personal");
  mkdirSync(folder);
  writeFileSync(path.join(f.cwd, "qc.config.json"), JSON.stringify({ github: { configDirs: { shawrylk: folder } } }));
  f.run("PostToolUse", "gh issue close 4");
  f.run("PostToolUse", "gh pr view 7");
  f.update({ fail: true });
  const note = JSON.stringify(f.run("UserPromptSubmit"));
  assert.match(note, /could not be checked/);
  assert.doesNotMatch(note, /TOKEN_MUST_STAY_SECRET/);
  f.update();
  const output = f.run("UserPromptSubmit").hookSpecificOutput.additionalContext;
  for (const id of [1, 2, 3, 4, 5]) assert.match(output, new RegExp(`Comment ${id}`));
  assert.equal(f.run("UserPromptSubmit"), null);
  f.rows.push({ ...f.rows[0], body: "Edited comment" });
  f.update();
  assert.match(JSON.stringify(f.run("UserPromptSubmit")), /Edited comment/);
  assert.equal(f.run("UserPromptSubmit", "", "comment-watch.mjs", "other-session"), null);
  const calls = readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(calls.some(call => call.args.some(arg => arg.includes("ArentInc/other")) && call.config === undefined));
  assert.ok(calls.some(call => call.config === folder));
  const customFolder = path.join(f.cwd, "custom-gh");
  mkdirSync(customFolder);
  writeFileSync(path.join(f.cwd, "qc.config.json"), JSON.stringify({ github: { configDirs: { shawrylk: customFolder } } }));
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
  assert.notEqual(passed?.hookSpecificOutput?.permissionDecision, "deny", JSON.stringify(passed));
  writeFileSync(path.join(f.cwd, "qc.config.json"), JSON.stringify({ commentWatch: false }));
  assert.notEqual(f.run("PreToolUse", command, "merge-guard.mjs", "other-session")?.hookSpecificOutput?.permissionDecision, "deny");
});

test("combined message flags and numbered commands register watches in both shells", () => {
  for (const tool_name of ["Bash", "PowerShell"]) {
    for (const flag of ["-am", "-qam", "-sm"]) {
      assert.equal(watchedItems({ tool_name, tool_input: { command: `git commit ${flag} "Refs #9"` } }, "owner/repo")[0]?.number, 9);
    }
    for (const command of ["gh pr review 7 --approve", "gh pr edit https://github.com/owner/repo/pull/7 --title title", "gh issue reopen 7"]) {
      assert.equal(watchedItems({ tool_name, tool_input: { command } }, "owner/repo")[0]?.number, 7);
    }
  }
});

test("only session-created URLs are skipped, including reviews and PRs", (t) => {
  const f = fixture(t);
  for (const [command, output] of [
    ['gh issue comment 4 --body "Comment 1"', 'https://github.com/comments/1'],
    ['gh pr review --approve', { id: 2, body: 'https://github.com/comments/4' }],
    ['gh api -X POST repos/shawrylk/example/pulls/7/comments -f body="Comment 3"', { output: '{"id":3}' }],
    ['gh pr create --body "Fixes #4"', 'https://github.com/shawrylk/example/pull/7'],
  ]) f.run("PostToolUse", command, "comment-watch.mjs", "session-a", output);
  const output = JSON.stringify(f.run("UserPromptSubmit"));
  assert.doesNotMatch(output, /Comment [123]\b/);
  assert.match(output, /Comment 4/);
});

test("full reads acknowledge only the comment kinds their output contains", (t) => {
  for (const [command, seen] of [
    ["gh issue view 4 --comments", [1]],
    ["gh api repos/shawrylk/example/issues/4/comments", [1]],
    ["gh api repos/shawrylk/example/issues/comments/1", [1]],
    ["gh api -X GET repos/shawrylk/example/issues/4", []],
    ["gh api -X POST repos/shawrylk/example/issues/4/comments", []],
    ["gh pr view 7 --comments", [2, 4]],
    ["gh api repos/shawrylk/example/pulls/7/comments", [3]],
    ["gh api repos/shawrylk/example/pulls/7/reviews", [2]],
    ["gh api repos/shawrylk/example/pulls/comments/3", [3]],
    ["gh api repos/shawrylk/example/pulls/7", []],
    ["gh api repos/shawrylk/example/pulls/7/reviews/2", []],
  ]) {
    const f = fixture(t);
    for (const row of f.rows) row.body = `Comment ${row.id} ` + "x".repeat(850) + "hidden request";
    f.update();
    f.run("PostToolUse", "gh pr view 7");
    const output = JSON.stringify(f.run("UserPromptSubmit"));
    assert.match(output, /truncated/i, command);
    assert.match(output, /gh api repos\/shawrylk\/example\/pulls\/7\/comments --paginate/, command);
    assert.doesNotMatch(output, /hidden request/, command);
    assert.match(JSON.stringify(f.run("UserPromptSubmit")), /truncated/i, command);
    assert.equal(f.run("PreToolUse", "gh pr merge 7", "merge-guard.mjs")?.hookSpecificOutput?.permissionDecision, "deny", command);
    f.run("PostToolUse", command, "comment-watch.mjs", "session-a", { exit_code: 1 });
    assert.match(JSON.stringify(f.run("UserPromptSubmit")), /truncated/i, command);
    f.run("PostToolUse", command);
    const remaining = JSON.stringify(f.run("UserPromptSubmit"));
    for (const row of f.rows) assert.equal(remaining.includes(`Comment ${row.id} `), !seen.includes(row.id), command);
  }
});

for (const command of [
  "cd /home/shawry/Documents/GitHub/architecture-kit; gh api repos/shawrylk/architecture-kit/issues/236/comments --paginate --jq '.[-1].body' | tail -c 600",
  "gh api repos/shawrylk/architecture-kit/issues/236/comments --paginate --jq '.[].id'",
  "gh api repos/shawrylk/architecture-kit/issues/236/comments --paginate -q '.[].id'",
  "gh api repos/shawrylk/architecture-kit/issues/236/comments --paginate --template '{{range .}}{{.id}}{{end}}'",
  "gh api repos/shawrylk/architecture-kit/issues/236/comments --paginate -t '{{range .}}{{.id}}{{end}}'",
  "gh api --template 'repos/other/project/issues/9/comments' repos/shawrylk/architecture-kit/issues/236/comments --paginate",
]) test(`Bash full reads acknowledge pending stamps: ${command}`, (t) => {
  const f = fixture(t);
  f.rows[0].endpoint = "issues/236/comments";
  f.rows[0].body = "x".repeat(850);
  f.update();
  f.run("PostToolUse", "gh issue view 236 -R shawrylk/architecture-kit");
  assert.match(JSON.stringify(f.run("UserPromptSubmit")), /truncated/);
  const ledgerPath = path.join(f.cwd, ".git", "qc", `comment-watch-${createHash("sha256").update("session-a").digest("hex")}.jsonl`);
  const records = () => readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const pending = records().flatMap(record => record.pending ?? []);
  assert.equal(pending.length, 1);
  assert.ok(!records().some(record => record.seen?.includes(pending[0].stamp)));
  f.run("PostToolUse", command, "comment-watch.mjs", "session-a", {
    stdout: "1", stderr: "", interrupted: false, isImage: false,
  }, "Bash");
  assert.ok(records().some(record => record.seen?.includes(pending[0].stamp)));
});

test("review flags preserve the state and body in both shells", (t) => {
  for (const tool of ["Bash", "PowerShell"]) {
    for (const [flags, body, state] of [
      ["-ab LGTM", "LGTM", "APPROVED"],
      ["-abLGTM", "LGTM", "APPROVED"],
      ["-abconfirm", "confirm", "APPROVED"],
      ["-rbproblem", "problem", "CHANGES_REQUESTED"],
      ["-cbm", "m", "COMMENTED"],
      ["-ab-r", "-r", "APPROVED"],
      ["-ab=LGTM", "LGTM", "APPROVED"],
      ['-ab="line1\nline2"', "line1\nline2", "APPROVED"],
      ["-ab 'line1\nline2'", "line1\nline2", "APPROVED"],
      ['-ab "line1\nline2"', "line1\nline2", "APPROVED"],
      ["-rbNo", "No", "CHANGES_REQUESTED"],
      ['-rb "x"', "x", "CHANGES_REQUESTED"],
      ["-c -b x", "x", "COMMENTED"],
      ["--approve --body x", "x", "APPROVED"],
      ['-ab "-rb"', "-rb", "APPROVED"],
      ["-a -b=text", "text", "APPROVED"],
      ["--request-changes --body=text", "text", "CHANGES_REQUESTED"],
      ["-a", "", "APPROVED"],
      ["-r", "", "CHANGES_REQUESTED"],
    ]) {
      const f = fixture(t);
      const command = `gh pr review 7 ${flags}`;
      f.run("PreToolUse", command, "comment-watch.mjs", "session-a", "", tool);
      f.run("PostToolUse", command, "comment-watch.mjs", "session-a", "", tool);
      const dir = path.join(f.cwd, ".git", "qc");
      const file = readdirSync(dir).find(name => name.startsWith("comment-watch-"));
      const records = readFileSync(path.join(dir, file), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      const review = records.find(record => record.review)?.review;
      assert.equal(review?.state, state, `${tool}: ${flags}`);
      assert.equal(review?.bodyHash, createHash("sha256").update(body).digest("hex"), `${tool}: ${flags}`);
      assert.equal(review?.empty, body.length === 0, `${tool}: ${flags}`);
    }
  }
});

test("pending session reviews match body or empty-body state once after the start", (t) => {
  const f = fixture(t);
  for (const [id, body, state, submitted_at] of [
    [20, "session body", "COMMENTED", "2000-01-01T00:00:00Z"],
    [21, "other body", "COMMENTED", "2099-01-01T00:00:00Z"],
    [22, "session body", "COMMENTED", "2099-01-01T00:00:00Z"],
    [23, "", "CHANGES_REQUESTED", "2099-01-01T00:00:00Z"],
    [24, "", "APPROVED", "2099-01-01T00:00:00Z"],
    [25, "", "APPROVED", "2099-01-01T00:00:00Z"],
  ]) f.rows.push({ id, body, state, submitted_at, endpoint: "pulls/7/reviews", html_url: `https://github.com/reviews/${id}` });
  f.update();
  f.run("PreToolUse", 'gh pr review 7 --comment --body "session body"');
  f.run("PostToolUse", 'gh pr review 7 --comment --body "session body"');
  f.run("PreToolUse", "gh pr review 7 --approve");
  f.run("PostToolUse", "gh pr review 7 --approve");
  const output = JSON.stringify(f.run("UserPromptSubmit"));
  for (const id of [20, 21, 23, 25]) assert.ok(output.includes(`/reviews/${id}`));
  for (const id of [22, 24]) assert.ok(!output.includes(`/reviews/${id}`));
  f.rows.find(row => row.id === 22).body = "edited session review";
  f.rows.push({ ...f.rows.find(row => row.id === 22), id: 26, html_url: "https://github.com/reviews/26", body: "session body" });
  f.update();
  const next = JSON.stringify(f.run("UserPromptSubmit"));
  assert.doesNotMatch(next, /edited session review/);
  assert.match(next, /reviews\/26/);
});

test("references inside code spans and fences name no issue", () => {
  const body = "Fixes #5. The button is `#128282`.\n\n```css\ncolor: #1d6496; /* #9 */\n```\n\nRefs #6";
  const items = watchedItems({ tool_name: "Bash", tool_input: { command: `gh pr create --body '${body}'` } }, "owner/repo", PARSERS.Bash);
  assert.deepEqual(items.map(({ number }) => number).sort((a, b) => a - b), [5, 6]);
});

test("a PR body read at merge skips hex colours in code spans", (t) => {
  const f = fixture(t);
  f.update({ body: "Fixes #4. Teal is `#128282`." });
  f.run("PostToolUse", "gh pr view 7");
  f.run("PreToolUse", "gh pr merge 7", "merge-guard.mjs");
  assert.doesNotMatch(readFileSync(f.calls, "utf8"), /issues\/128282/);
});

test("merge targets include commit-only references and previously watched issues", (t) => {
  const f = fixture(t);
  f.rows.length = 0;
  f.rows.push(...[9, 10].map(id => ({ id, endpoint: `issues/${id}/comments`, body: `Comment ${id}`, html_url: `https://github.com/comments/${id}` })));
  f.update({ commits: [{ messageHeadline: "Fixes #9", messageBody: "Refs #11" }] });
  f.run("PostToolUse", "gh pr view 7");
  f.run("PostToolUse", 'git commit -m "Refs #10"');
  const output = f.run("PreToolUse", "gh pr merge 7", "merge-guard.mjs");
  assert.match(JSON.stringify(output), /Comment 9/);
  assert.match(JSON.stringify(output), /Comment 10/);
});

test("full reads acknowledge truncated previews from a merge refusal or Stop", (t) => {
  for (const event of ["PreToolUse", "Stop"]) {
    const f = fixture(t);
    f.rows[0].body = "x".repeat(850);
    f.update();
    f.run("PostToolUse", "gh pr view 7");
    assert.match(JSON.stringify(f.run(event, "gh pr merge 7", event === "PreToolUse" ? "merge-guard.mjs" : "comment-watch.mjs")), /truncated/);
    f.run("PostToolUse", "gh issue view 4 --comments");
    assert.doesNotMatch(JSON.stringify(f.run("UserPromptSubmit")), /truncated/);
  }
});

test("API merges check comments with dispatch on and off in both shells", (t) => {
  const f = fixture(t);
  for (const dispatch of [false, true]) {
    writeFileSync(path.join(f.cwd, "qc.config.json"), JSON.stringify({ swarm: dispatch ? { dispatch: {} } : {} }));
    for (const tool of ["Bash", "PowerShell"]) {
      for (const command of ["gh api -X PUT repos/shawrylk/example/pulls/7/merge", 'gh api graphql -f query=\'mutation { mergePullRequest(input: {pullRequestId: "PR_7"}) { clientMutationId } }\'']) {
        const output = f.run("PreToolUse", command, "merge-guard.mjs", "session-a", "", tool);
        assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
        assert.match(JSON.stringify(output), /Comment 4/);
      }
    }
  }
});

test("polls use one issue request and three PR requests in parallel", (t) => {
  const f = fixture(t);
  f.run("PostToolUse", "gh pr view 7");
  writeFileSync(f.calls, "");
  f.update({ delay: 250 });
  f.run("UserPromptSubmit");
  const calls = readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse).filter(call => call.start);
  assert.equal(calls.length, 5);
  assert.ok(Math.max(...calls.map(call => call.start)) - Math.min(...calls.map(call => call.start)) < 200);
  assert.ok(calls.every(call => call.args.includes("--paginate")));
  assert.ok(calls.every(call => !call.args.includes("--slurp")));
  f.rows[0].body = "Retry this item";
  f.update({ failEndpoint: "issues/4/comments" });
  assert.match(JSON.stringify(f.run("UserPromptSubmit")), /shawrylk\/example#4 could not be checked; retry on the next prompt/);
  f.update();
  assert.match(JSON.stringify(f.run("UserPromptSubmit")), /Retry this item/);
});
