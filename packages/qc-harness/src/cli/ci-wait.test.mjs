import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EXIT, ciWait, judge, runCiWait } from "./ci-wait.mjs";

const MIN = 60_000;
const LIMITS = { max: 50, queued: 25, firstWait: 90, interval: 60 };
const check = (name, bucket, state = "IN_PROGRESS") => ({ name, bucket, state, link: `https://ci.example/${name}` });
const watchOf = () => ({ head0: "a1", startedMs: 0, queuedSince: new Map() });

test("a failed check ends the wait, and a pending one keeps it", () => {
  assert.equal(judge({ head: "a1", checks: [check("unit", "fail", "FAILURE"), check("e2e", "pending")] }, watchOf(), MIN, LIMITS).why, "failed");
  assert.equal(judge({ head: "a1", checks: [check("unit", "pending")] }, watchOf(), MIN, LIMITS), null);
  assert.equal(judge({ head: "a1", checks: [check("unit", "pass", "SUCCESS"), check("lint", "skipping", "SKIPPED")] }, watchOf(), MIN, LIMITS).why, "green");
});

test("a new head ends the wait, and no checks yet keeps it", () => {
  assert.equal(judge({ head: "b2", checks: [check("unit", "pending")] }, watchOf(), MIN, LIMITS).why, "new-head");
  assert.equal(judge({ head: "a1", checks: [] }, watchOf(), MIN, LIMITS), null);
});

test("a check queued for the limit is stuck, and the time limit ends the wait", () => {
  const watch = watchOf();
  const queued = { head: "a1", checks: [check("unit", "pending", "QUEUED")] };
  assert.equal(judge(queued, watch, 0, LIMITS), null);
  assert.equal(judge(queued, watch, 25 * MIN, LIMITS).why, "stuck-queued");
  assert.equal(judge({ head: "a1", checks: null }, watchOf(), 50 * MIN, LIMITS).why, "timeout");
});

/** Reads that answer from a script, one look for each sleep, and a clock that the sleeps move. */
function scripted(looks, order = []) {
  let clock = 0;
  let index = -1;
  const look = () => looks[Math.max(0, Math.min(index, looks.length - 1))];
  return {
    now: () => clock,
    sleep: async (ms) => {
      order.push("sleep");
      clock += ms;
      index += 1;
    },
    readHead: () => {
      order.push("head");
      return look().head;
    },
    readChecks: () => look().checks,
  };
}

test("the head is read only after the first wait", async () => {
  const order = [];
  const outcome = await ciWait(7, LIMITS, scripted([{ head: "a1", checks: [check("unit", "pass", "SUCCESS")] }], order));
  assert.equal(outcome.why, "green");
  assert.equal(order[0], "sleep");
});

test("with gh failing on every read, the wait ends at the time limit and never throws", async () => {
  const outcome = await ciWait(7, LIMITS, scripted([{ head: null, checks: null }]));
  assert.equal(outcome.why, "timeout");
});

test("the command prints the reason and the failed checks, and exits with the reason's code", async () => {
  const said = [];
  const reads = scripted([{ head: "a1", checks: [check("unit (3)", "fail", "FAILURE")] }]);
  const code = await runCiWait(["7", "--first-wait", "1"], { reads, say: (line) => said.push(line) });
  assert.equal(code, EXIT.failed);
  assert.match(said.join("\n"), /PR 7 head a1 -> failed/);
  assert.match(said.join("\n"), /fail +unit \(3\) +https:\/\/ci\.example/);
  assert.equal(await runCiWait(["seven"], { reads, say: () => {} }), EXIT.usage);
});
