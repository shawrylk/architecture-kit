import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decide } from "./cost-stop.mjs";
import { appendRecord, readLedger } from "./ledger.mjs";

const HOOK = fileURLToPath(new URL("./cost-stop.mjs", import.meta.url));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

/** A checkout with the workflow on (or off), and a folder for transcripts. */
function workspace(t, on = true) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-cost-stop-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, "repo");
  git(base, "init", "-q", "-b", "main", repo);
  for (const [key, value] of [["user.name", "qc"], ["user.email", "qc@example.com"], ["commit.gpgsign", "false"]]) git(repo, "config", key, value);
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "branch", "feat/1-x");
  writeFileSync(path.join(repo, "qc.config.json"), JSON.stringify(on ? { swarm: { dispatch: {} } } : { swarm: {} }));
  const tmp = path.join(base, "tmp");
  mkdirSync(tmp);
  return { base, repo, tmp, head: git(repo, "rev-parse", "HEAD"), ledger: path.join(repo, ".git", "qc", "ledger.jsonl") };
}

const usage = (input, output, read, write) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
});
const assistant = (id, model, use, tools = []) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-10-09T10:00:00.000Z",
    message: { id, model, usage: use, content: tools.map((toolId) => ({ type: "tool_use", id: toolId, name: "Read", input: {} })) },
  });
const prompt = (text) => JSON.stringify({ type: "user", message: { role: "user", content: text } });

/** A subagent transcript: the dispatch prompt, then two requests, one of them split over two lines of one message id. */
function transcript(ws, name, prompts) {
  const file = path.join(ws.base, `${name}.jsonl`);
  writeFileSync(
    file,
    [
      prompt(prompts),
      assistant("m1", "claude-sonnet-5-5", usage(10, 100, 1000, 200), ["t1"]),
      assistant("m1", "claude-sonnet-5-5", usage(10, 100, 1000, 200), ["t2"]),
      assistant("m2", "claude-sonnet-5-5", usage(5, 50, 3000, 0), ["t3", "t4"]),
    ].join("\n") + "\n",
  );
  return file;
}

const stop = (ws, file, agentType, extra = {}) => ({
  hook_event_name: "SubagentStop",
  session_id: "s",
  cwd: ws.repo,
  agent_id: "agent-1",
  agent_type: agentType,
  agent_transcript_path: file,
  ...extra,
});

const costs = (ws) => readLedger(ws.ledger).filter((record) => record.type === "cost");

test("a subagent stop records its tokens once per request, its tool calls, and the branch and head of its dispatch", (t) => {
  const ws = workspace(t);
  appendRecord(ws.ledger, { type: "dispatch", session: "s", agentType: "sdd-implementer", task: true, worktree: ws.repo, branch: "feat/1-x", head: ws.head });
  const file = transcript(ws, "a", `Worktree: ${ws.repo}\nBuild it.`);
  assert.equal(decide(stop(ws, file, "sdd-implementer"), ws.tmp), null);
  const [record] = costs(ws);
  assert.deepEqual(
    { ...record, at: undefined },
    {
      type: "cost",
      at: undefined,
      session: "s",
      agentId: "agent-1",
      agentType: "sdd-implementer",
      role: "implementer",
      model: "claude-sonnet-5-5",
      input: 15,
      output: 150,
      cacheRead: 4000,
      cacheCreation: 200,
      toolCalls: 4,
      branch: "feat/1-x",
      head: ws.head,
    },
  );
  assert.equal(typeof record.at, "string");
});

test("each agent type maps to its role, and a type the workflow does not know is other", (t) => {
  const ws = workspace(t);
  const file = transcript(ws, "a", "No worktree named.");
  for (const [agentType, role] of [
    ["sdd-implementer", "implementer"],
    ["sdd-reviewer", "reviewer"],
    ["sdd-branch-reviewer", "branch-reviewer"],
    ["sdd-planner", "planner"],
    ["Explore", "other"],
  ]) {
    decide(stop(ws, file, agentType, { agent_id: `id-${agentType}` }), ws.tmp);
  }
  assert.deepEqual(
    costs(ws).map((record) => [record.agentType, record.role]),
    [["sdd-implementer", "implementer"], ["sdd-reviewer", "reviewer"], ["sdd-branch-reviewer", "branch-reviewer"], ["sdd-planner", "planner"], ["Explore", "other"]],
  );
});

test("a stop with no matching dispatch records a null branch and head", (t) => {
  const ws = workspace(t);
  appendRecord(ws.ledger, { type: "dispatch", session: "other", agentType: "sdd-implementer", task: true, worktree: ws.repo, branch: "feat/9-z", head: ws.head });
  const file = transcript(ws, "a", `Worktree: ${ws.repo}\nBuild it.`);
  decide(stop(ws, file, "sdd-implementer"), ws.tmp);
  assert.deepEqual([costs(ws)[0].branch, costs(ws)[0].head], [null, null]);
});

test("nothing is recorded while swarm.dispatch is off, or when the transcript does not read", (t) => {
  const off = workspace(t, false);
  assert.equal(decide(stop(off, transcript(off, "a", "x"), "sdd-implementer"), off.tmp), null);
  assert.deepEqual(costs(off), []);
  const on = workspace(t);
  assert.equal(decide(stop(on, path.join(on.base, "missing.jsonl"), "sdd-implementer"), on.tmp), null);
  writeFileSync(path.join(on.base, "empty.jsonl"), "");
  assert.equal(decide(stop(on, path.join(on.base, "empty.jsonl"), "sdd-implementer"), on.tmp), null);
  assert.deepEqual(costs(on), []);
  assert.equal(decide({ hook_event_name: "SubagentStop", session_id: "s", cwd: on.repo, agent_type: "x" }, on.tmp), null, "the main session has no agent id");
});

test("the hook script writes the record and prints nothing", (t) => {
  const ws = workspace(t);
  const file = transcript(ws, "a", "No worktree named.");
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(stop(ws, file, "sdd-implementer")),
    env: { ...process.env, TEMP: ws.tmp, TMP: ws.tmp, TMPDIR: ws.tmp },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(costs(ws).length, 1);
});
