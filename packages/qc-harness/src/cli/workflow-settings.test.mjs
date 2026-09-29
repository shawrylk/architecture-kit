import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { dispatchDefaults, reviewDefaults } from "../config.mjs";
import { rememberSession, reviewSettings, sessionDirOf, workflowAt, workflowOf } from "./workflow-settings.mjs";

/** One git checkout per config; `null` writes no config. The last folder is outside any checkout. */
function folders(t, configs) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-workflow-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dirs = configs.map((config, index) => {
    const dir = path.join(base, String(index));
    mkdirSync(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" });
    if (config !== null) writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify(config));
    return dir;
  });
  const outside = path.join(base, "outside");
  const tmp = path.join(base, "tmp");
  mkdirSync(outside);
  mkdirSync(tmp);
  return { dirs, outside, tmp };
}

test("with swarm.dispatch off, the checks are off", (t) => {
  assert.equal(reviewSettings({}), null);
  assert.equal(reviewSettings({ toolCallBudget: 5, review: { merge: "task" } }), null);
  const { dirs } = folders(t, [null, { swarm: { toolCallBudget: 50 } }]);
  for (const dir of dirs) assert.equal(workflowAt(dir), null);
});

test("an empty dispatch section takes every review default", () => {
  assert.deepEqual(reviewSettings({ dispatch: {} }), { ...reviewDefaults, implementerTypes: dispatchDefaults.implementerTypes });
});

test("a repository overrides one reviewer kind and keeps the other", () => {
  const settings = reviewSettings({ dispatch: {}, review: { merge: "task", reviewerTypes: { task: ["my-reviewer"] } } });
  assert.equal(settings.merge, "task");
  assert.deepEqual(settings.reviewerTypes.task, ["my-reviewer"]);
  assert.deepEqual(settings.reviewerTypes.branch, reviewDefaults.reviewerTypes.branch);
});

test("a bad key throws and names it", () => {
  for (const [review, key] of [
    [{ merge: "squash" }, /swarm\.review\.merge/],
    [{ maxTaskCalls: 0 }, /swarm\.review\.maxTaskCalls/],
    [{ controllerPaths: "docs/**" }, /swarm\.review\.controllerPaths/],
    [{ reviewerTypes: { task: [""] } }, /swarm\.review\.reviewerTypes\.task/],
    [{ plannerTypes: [1] }, /swarm\.review\.plannerTypes/],
    ["on", /swarm\.review in qc\.config\.json must be an object/],
    [{ mergeKind: "task" }, /swarm\.review\.mergeKind/],
    [{ merge: "task", maxTaskCall: 5 }, /swarm\.review\.maxTaskCall/],
  ]) {
    assert.throws(() => reviewSettings({ dispatch: {}, review }), key);
  }
});

test("workflowAt names the checkout, its ledger, its settings, and its protected branches", (t) => {
  const { dirs } = folders(t, [{ swarm: { dispatch: {} } }]);
  const found = workflowAt(dirs[0]);
  assert.equal(found.root, dirs[0]);
  assert.equal(found.ledger, path.join(dirs[0], ".git", "qc", "ledger.jsonl"));
  assert.equal(found.review.merge, "branch");
  assert.deepEqual(found.protectedBranches, ["main", "master"]);
  assert.equal(existsSync(found.ledger), false, "reading the settings writes nothing");
});

test("a hook whose cwd holds no config reads the checkout its session remembered", (t) => {
  const { dirs, outside, tmp } = folders(t, [{ swarm: { dispatch: {} } }]);
  const call = { session_id: "s-1", cwd: outside };
  assert.equal(workflowOf(call, tmp), null);
  rememberSession("s-1", dirs[0], tmp);
  assert.ok(existsSync(path.join(sessionDirOf("s-1", tmp), "state.json")));
  assert.equal(workflowOf(call, tmp).root, dirs[0]);
  assert.equal(workflowOf({ session_id: "s-2", cwd: outside }, tmp), null);
});
