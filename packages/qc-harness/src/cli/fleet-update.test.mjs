import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { jobsBusy, jobsHeartbeat, jobsTick } from "./fleet-jobs.mjs";
import { platformBusy } from "./fleet-platform.mjs";
import { readState, writeState } from "./fleet-state.mjs";
import { KIT_VERSION, pendingUpdate, requestUpdate, startUpdate, validKitVersion } from "./fleet-update.mjs";

function tempRoot(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-update-"));
  mkdirSync(path.join(root, ".git", "qc", "fleet"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

test("a version is three plain numbers; a tag, a range or a path is refused", () => {
  for (const value of ["0.32.0", "10.2.33"]) assert.equal(validKitVersion(value), true);
  for (const value of ["latest", "^0.32.0", "0.32", "0.32.0-beta", "0.32.0 && x", "../x", 1, undefined]) assert.equal(validKitVersion(value), false);
});

test("a requested update is saved, stops new jobs and ignores the running version and bad versions", t => {
  const root = tempRoot(t);
  writeState(root, "node", { pid: 1, jobs: { mode: 5 } });
  assert.equal(requestUpdate(root, KIT_VERSION), false);
  assert.equal(requestUpdate(root, "latest"), false);
  assert.equal(pendingUpdate(root), undefined);
  assert.equal(jobsHeartbeat(root).max, 5);
  assert.equal(requestUpdate(root, "999.0.0"), true);
  assert.deepEqual(readState(root, "node"), { pid: 1, jobs: { mode: 5 }, update: { version: "999.0.0" } });
  assert.equal(pendingUpdate(root), "999.0.0");
  assert.equal(jobsHeartbeat(root).max, 0);
});

test("a saved request for the running version is not pending, so a node cannot restart in a loop", t => {
  const root = tempRoot(t);
  writeState(root, "node", { pid: 1, jobs: { mode: 5 }, update: { version: KIT_VERSION } });
  assert.equal(pendingUpdate(root), undefined);
  assert.equal(jobsHeartbeat(root).max, 5);
});

test("a node is busy for an update while a jobs tick or a platform tick runs", async t => {
  const root = tempRoot(t);
  assert.equal(jobsBusy(root), false); assert.equal(platformBusy(root), false);
  let release; const gate = new Promise(resolve => { release = resolve; });
  writeState(root, "queue", [{ id: "1", repo: "o/r", from: "leader", kind: "codex-slots", body: { mode: 1 } }]);
  writeState(root, "peers", { leader: { time: Date.now(), leader: true, term: 1 } });
  const tick = jobsTick({ root, fleet: { self: "b", secret: "ab".repeat(32), nodes: [] }, repo: "o/r", warn() {},
    git: async () => { await gate; return { stdout: "" }; }, fetch: async () => ({ status: 202 }) });
  release(); await tick;
  assert.equal(jobsBusy(root), false);
});

test("the update helper gets the old process id, the version, the role and the job mode", t => {
  const root = tempRoot(t), calls = [];
  const run = (command, args, options) => { calls.push({ command, args, options }); return { unref() {} }; };
  startUpdate({ root, version: "999.0.0", leader: true, mode: "auto", pid: 4242, run });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args.slice(2, 6), ["4242", "999.0.0", "1", "auto"]);
  assert.match(calls[0].args[6], /qc\.mjs$/);
  assert.equal(calls[0].options.detached, true); assert.equal(calls[0].options.cwd, root);
  assert.throws(() => startUpdate({ root, version: "latest", leader: false, mode: 2, run }), /invalid kit version/);
});
