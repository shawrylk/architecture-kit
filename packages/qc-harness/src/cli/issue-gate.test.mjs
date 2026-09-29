import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decide, issueStatus } from "./issue-gate.mjs";
import { appendRecord, readLedger } from "./ledger.mjs";
import { rememberSession } from "./workflow-settings.mjs";

const HOOK = fileURLToPath(new URL("./issue-gate.mjs", import.meta.url));
const MERGED_AT = "2026-09-29T04:35:17Z";

function workspace(t) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-issue-gate-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const on = path.join(base, "on");
  const off = path.join(base, "off");
  execFileSync("git", ["init", "-q", on], { stdio: "pipe" });
  execFileSync("git", ["init", "-q", off], { stdio: "pipe" });
  writeFileSync(path.join(on, "qc.config.json"), JSON.stringify({ swarm: { dispatch: {} } }));
  writeFileSync(path.join(off, "qc.config.json"), JSON.stringify({ swarm: {} }));
  return { on, off, ledger: path.join(on, ".git", "qc", "ledger.jsonl") };
}

const merge = (session, issues, extra = {}) => ({
  type: "merge",
  session,
  pr: 60,
  repo: "o/r",
  sha: "abc1234",
  branch: "feat/62-x",
  base: "main",
  mergedAt: MERGED_AT,
  issues,
  ghEnv: {},
  ...extra,
});
const stopCall = (cwd, session = "s") => ({ session_id: session, cwd, hook_event_name: "Stop", stop_hook_active: false });

/** A gh stand-in answering `gh issue view <n>` from a map of issue number to view. */
function fakeGh(views) {
  const calls = [];
  return {
    calls,
    gh: (args, options) => {
      calls.push({ args, options });
      const view = views[args[2]];
      return view === undefined ? null : JSON.stringify(view);
    },
  };
}

test("issueStatus reads a close, a comment after the merge, and an open issue", () => {
  assert.equal(issueStatus({ state: "CLOSED", comments: [] }, MERGED_AT), "closed");
  assert.equal(issueStatus({ state: "OPEN", comments: [{ createdAt: "2026-09-29T05:00:00Z" }] }, MERGED_AT), "commented");
  assert.equal(issueStatus({ state: "OPEN", comments: [{ createdAt: "2026-09-28T00:00:00Z" }] }, MERGED_AT), "open");
  assert.equal(issueStatus({}, MERGED_AT), null);
});

test("with swarm.dispatch off, or no merge in this session, the stop passes with no gh call", (t) => {
  const ws = workspace(t);
  appendRecord(ws.ledger, merge("other-session", [{ repo: "o/r", number: 12 }]));
  const { gh, calls } = fakeGh({});
  assert.equal(decide(stopCall(ws.off), { gh }), null);
  assert.equal(decide(stopCall(ws.on), { gh }), null);
  assert.equal(calls.length, 0);
});

test("a closed issue and a commented one are settled once, and never asked about again", (t) => {
  const ws = workspace(t);
  appendRecord(ws.ledger, merge("s", [{ repo: "o/r", number: 59 }, { repo: "o/r", number: 12 }]));
  const first = fakeGh({ 59: { state: "CLOSED", comments: [] }, 12: { state: "OPEN", comments: [{ createdAt: "2026-09-29T06:00:00Z" }] } });
  assert.equal(decide(stopCall(ws.on), { gh: first.gh }), null);
  assert.deepEqual(first.calls.map((call) => call.args), [
    ["issue", "view", "59", "-R", "o/r", "--json", "state,comments"],
    ["issue", "view", "12", "-R", "o/r", "--json", "state,comments"],
  ]);
  assert.deepEqual(
    readLedger(ws.ledger).filter((record) => record.type === "issue-update").map((record) => [record.number, record.how, record.prRepo, record.pr]),
    [[59, "closed", "o/r", 60], [12, "commented", "o/r", 60]],
  );
  const second = fakeGh({});
  assert.equal(decide(stopCall(ws.on), { gh: second.gh }), null);
  assert.equal(second.calls.length, 0);
});

test("an open issue with no comment since the merge blocks the stop and names both ways out", (t) => {
  const ws = workspace(t);
  appendRecord(ws.ledger, merge("s", [{ repo: "o/r", number: 12 }], { base: "develop", ghEnv: { GH_CONFIG_DIR: "~/.config/gh-personal" } }));
  const { gh, calls } = fakeGh({ 12: { state: "OPEN", comments: [{ createdAt: "2026-09-28T00:00:00Z" }] } });
  const output = decide(stopCall(ws.on), { gh });
  assert.equal(output.decision, "block");
  assert.match(output.reason, /o\/r#12, named by o\/r#60 \(merged into develop\)/);
  assert.match(output.reason, /GH_CONFIG_DIR=~\/\.config\/gh-personal gh issue close 12 -R o\/r --comment/);
  assert.match(output.reason, /gh issue comment 12 -R o\/r --body/);
  assert.deepEqual(calls[0].options.env, { GH_CONFIG_DIR: "~/.config/gh-personal" });
  assert.equal(readLedger(ws.ledger).some((record) => record.type === "issue-update"), false);
});

test("an issue gh cannot read is named to the user, blocks nothing, and is asked about again", (t) => {
  const ws = workspace(t);
  appendRecord(ws.ledger, merge("s", [{ repo: "o/r", number: 77 }]));
  const output = decide(stopCall(ws.on), { gh: fakeGh({}).gh });
  assert.equal(output.decision, undefined);
  assert.match(output.systemMessage, /o\/r#77/);
  const again = fakeGh({});
  decide(stopCall(ws.on), { gh: again.gh });
  assert.equal(again.calls.length, 1);
});

test("a stop already blocked once by this hook is never blocked again, and the open issues are named", (t) => {
  const ws = workspace(t);
  appendRecord(ws.ledger, merge("s", [{ repo: "o/r", number: 12 }]));
  const { gh } = fakeGh({ 12: { state: "OPEN", comments: [] } });
  const output = decide({ ...stopCall(ws.on), stop_hook_active: true }, { gh });
  assert.equal(output.decision, undefined);
  assert.match(output.systemMessage, /o\/r#12/);
});

test("a stop whose cwd holds no config finds the checkout its session remembered", (t) => {
  const ws = workspace(t);
  const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-issue-gate-tmp-")));
  const outside = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-issue-gate-out-")));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  appendRecord(ws.ledger, merge("s", [{ repo: "o/r", number: 12 }]));
  const { gh, calls } = fakeGh({ 12: { state: "OPEN", comments: [] } });
  assert.equal(decide(stopCall(outside), { gh, tmp }), null);
  assert.equal(calls.length, 0);
  rememberSession("s", ws.on, tmp);
  assert.equal(decide(stopCall(outside), { gh, tmp }).decision, "block");
  assert.equal(calls.length, 1);
});

test("the hook process is silent in a checkout without the checks", (t) => {
  const ws = workspace(t);
  const result = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(stopCall(ws.off)), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});
