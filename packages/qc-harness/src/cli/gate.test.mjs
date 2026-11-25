import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { decideGate } from "./gate.mjs";
import { decidePr } from "./pr-guard.mjs";
import { decide as decideMerge } from "./merge-guard.mjs";
import { appendRecord } from "./ledger.mjs";

const qc = fileURLToPath(new URL("./qc.mjs", import.meta.url));
function workspace(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "qc-gate-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q");
  git("checkout", "-qb", "feat/310-gates");
  git("remote", "add", "origin", "https://github.com/o/r.git");
  writeFileSync(path.join(cwd, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {} } }));
  git("add", ".");
  git("-c", "user.name=qc", "-c", "user.email=qc@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  return { cwd, sha: git("rev-parse", "HEAD") };
}
const input = (cwd, command, role = "leader") => ({ cwd, command, session: "codex-session", role });
const call = ({ cwd, command, session, role }) => ({ cwd, session_id: session, tool_name: "Bash", hook_event_name: "PreToolUse", tool_input: { command }, ...(role === "leader" ? {} : { agent_id: session }) });
const reason = (result) => result?.hookSpecificOutput?.permissionDecisionReason ?? null;

test("PR decisions preserve draft, worker, duplicate issue and exact-head readiness refusals", async (t) => {
  const { cwd, sha } = workspace(t);
  const deps = { gh: () => "[]" };
  for (const [command, role] of [["gh pr create", "leader"], ["gh pr create --draft", "implementer"]]) {
    const request = input(cwd, command, role);
    const result = await decideGate(request, deps);
    assert.equal(result.decision, "deny");
    assert.equal(result.reason, reason(decidePr(call(request), deps)));
  }
  assert.equal((await decideGate(input(cwd, "gh pr create --draft"), deps)).decision, "allow");
  const duplicate = await decideGate(input(cwd, "gh pr create --draft --body 'Refs #310'"), {
    gh: () => JSON.stringify([{ number: 7, headRefName: "feat/310-existing", body: "Refs #310" }]),
  });
  assert.match(duplicate.reason, /#310.*#7/);
  const request = input(cwd, "gh pr ready 7");
  const ready = { gh: () => JSON.stringify({ headRefOid: sha }), problems: (root, head) => {
    assert.equal(root, cwd); assert.equal(head, sha);
    return { missing: ["windows"], hits: [] };
  } };
  assert.equal((await decideGate(request, ready)).reason, reason(decidePr(call(request), ready)));
  assert.equal((await decideGate(request, { ...ready, problems: () => ({ missing: [], hits: [] }) })).decision, "allow");
});

test("merge decisions preserve pinning, exact-head review and async unread-comment checks", async (t) => {
  const { cwd, sha } = workspace(t);
  const gh = (args) => {
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ baseRefName: "main", headRefName: "feat/310-gates", number: 7, isCrossRepository: true, labels: [] });
    if (args[0] === "api") return sha;
    assert.fail(`unexpected gh: ${args}`);
  };
  const deps = { gh, commentCheck: async (hook) => { assert.equal(hook.session_id, "codex-session"); return null; } };
  appendRecord(path.join(cwd, ".git", "qc", "ledger.jsonl"), { type: "verdict", kind: "branch", sha: "f".repeat(40), verdict: "APPROVED" });
  for (const command of ["gh pr merge 7", `gh pr merge 7 --match-head-commit ${sha}`]) {
    const request = input(cwd, command);
    assert.equal((await decideGate(request, deps)).reason, reason(await decideMerge(call(request), deps)));
    assert.equal((await decideGate(request, deps)).decision, "deny");
  }
  appendRecord(path.join(cwd, ".git", "qc", "ledger.jsonl"), { type: "verdict", kind: "branch", sha, verdict: "APPROVED" });
  const request = input(cwd, `gh pr merge 7 --match-head-commit ${sha}`);
  assert.equal((await decideGate(request, deps)).decision, "allow");
  const unread = { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "unread comments" } };
  assert.equal((await decideGate(request, { ...deps, commentCheck: async () => unread })).reason, "unread comments");
  assert.equal(readFileSync(path.join(cwd, ".git", "qc", "ledger.jsonl"), "utf8").trim().split("\n").length, 2);
  const note = { hookSpecificOutput: { additionalContext: "checked comments" } };
  assert.equal((await decideGate(request, { ...deps, commentCheck: async () => note })).context, "checked comments");
});

test("shell decisions refuse bypasses and never execute requested actions", async (t) => {
  const { cwd } = workspace(t);
  assert.equal((await decideGate(input(cwd, "git -c core.hooksPath=/dev/null commit -m bypass"))).decision, "deny");
  const marker = JSON.stringify(path.join(cwd, "requested-action"));
  assert.equal((await decideGate(input(cwd, `node -e 'require("fs").writeFileSync(${marker}, "ran")'`))).decision, "allow");
  assert.equal(existsSync(path.join(cwd, "requested-action")), false);
});

test("CLI dispatch accepts explicit context, quotes PR arguments, and returns decisions without actions", (t) => {
  const { cwd, sha } = workspace(t);
  copyFileSync(process.execPath, path.join(cwd, process.platform === "win32" ? "gh.exe" : "gh"));
  const preload = path.join(cwd, "fake-gh.cjs");
  writeFileSync(preload, `
    if (require('node:path').basename(process.execPath).replace(/\\.exe$/, '') === 'gh') {
      const args = process.argv.slice(1);
      args[0] = require('node:path').basename(args[0]);
      require('node:fs').appendFileSync(${JSON.stringify(path.join(cwd, "gh-calls"))}, JSON.stringify(args) + '\\n');
      if (args[0] !== 'api' && !(args[0] === 'pr' && ['view', 'list'].includes(args[1]))) process.exit(99);
      console.log(args[1] === 'list' ? '[]' : JSON.stringify({ headRefOid: '${sha}' }));
      process.exit(0);
    }
  `);
  const env = { ...process.env, PATH: `${cwd}${path.delimiter}${process.env.PATH}`, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };
  const run = (action, args, role = "leader") => spawnSync(process.execPath, [qc, "gate", action, "--cwd", cwd, "--session", "cli-session", "--role", role, "--", ...args], { encoding: "utf8", cwd: os.tmpdir(), env });
  for (const [action, args] of [["pr-create", []], ["pr-ready", ["7"]], ["merge", ["7"]]]) {
    const result = run(action, args, "worker");
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).decision, "deny");
  }
  const quoted = run("pr-create", ["--title", "hello; touch requested-action"]);
  assert.match(JSON.parse(quoted.stdout).reason, /--draft/);
  const created = run("pr-create", ["--draft", "--body", "Refs #310; ' $(touch requested-action)"]);
  assert.equal(created.status, 0, created.stdout + created.stderr);
  assert.equal(run("pr-ready", ["7", "--undo"]).status, 0);
  const allowed = run("command", [`echo allowed > "${path.join(cwd, "requested-action")}"`]);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.deepEqual(JSON.parse(allowed.stdout), { decision: "allow", reason: null });
  assert.equal(run("command", ["git -c core.hooksPath=/dev/null status"]).status, 2);
  assert.equal(existsSync(path.join(cwd, "requested-action")), false);
  assert.ok(readFileSync(path.join(cwd, "gh-calls"), "utf8").trim().split("\n").every((line) => {
    const args = JSON.parse(line);
    return args[0] === "api" || (args[0] === "pr" && ["view", "list"].includes(args[1]));
  }));
  for (const args of [["gate"], ["gate", "unknown"], ["gate", "command", "--role", "unknown", "--", "echo hi"], ["gate", "command", "--", "echo hi"]]) {
    const result = spawnSync(process.execPath, [qc, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage: qc gate/);
  }
  const help = spawnSync(process.execPath, [qc, "help"], { encoding: "utf8" });
  assert.match(help.stdout, /qc gate <pr-create\|pr-ready\|merge\|command>/);
});

test("invalid context cannot produce an allow decision", async (t) => {
  const { cwd } = workspace(t);
  for (const override of [{ session: "" }, { role: "unknown" }, { command: "" }, { cwd: path.join(cwd, "missing") }, { cwd: path.join(cwd, "qc.config.json") }]) {
    await assert.rejects(decideGate({ ...input(cwd, "echo hi"), ...override }));
  }
});
