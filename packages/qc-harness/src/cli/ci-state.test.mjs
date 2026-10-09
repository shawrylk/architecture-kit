import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ciNotGreen, notGreenReason } from "./ci-state.mjs";

const SHA = "a".repeat(40);
const run = (name, status, conclusion = null) => ({ name, status, conclusion });
const reply = (...runs) => JSON.stringify({ total_count: runs.length, check_runs: runs });

test("a head whose check runs all completed green is green", () => {
  assert.equal(notGreenReason([run("lint", "completed", "success"), run("docs", "completed", "skipped"), run("x", "completed", "neutral")]), null);
});

test("each failing conclusion makes the head not green, and the reason names the run", () => {
  for (const conclusion of ["failure", "cancelled", "timed_out", "action_required"]) {
    assert.match(notGreenReason([run("ok", "completed", "success"), run("build", "completed", conclusion)]) ?? "", new RegExp(`build.*${conclusion}`));
  }
});

test("a run that has not completed makes the head not green", () => {
  for (const status of ["queued", "in_progress", "waiting", "pending"]) {
    assert.match(notGreenReason([run("build", status)]) ?? "", new RegExp(`build.*${status}`));
  }
});

test("a head with no check runs is unknown, not red", () => {
  assert.equal(notGreenReason([]), null);
});

test("ciNotGreen reads the check runs of the sha from the repository of origin", () => {
  const calls = [];
  const gh = (args, options) => {
    calls.push({ args, options });
    return reply(run("build", "completed", "failure"));
  };
  const reason = ciNotGreen(SHA, "/checkout", { gh, origin: () => "o/r" });
  assert.match(reason ?? "", /^CI on aaaaaaa:.*build.*failure/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], "api");
  assert.ok(calls[0].args[1].startsWith(`repos/o/r/commits/${SHA}/check-runs`));
  assert.equal(calls[0].options.cwd, "/checkout");
});

test("ciNotGreen is null when the head is green, gh fails, the reply is not JSON, or origin is unknown", () => {
  const origin = () => "o/r";
  assert.equal(ciNotGreen(SHA, "/c", { gh: () => reply(run("a", "completed", "success")), origin }), null);
  assert.equal(ciNotGreen(SHA, "/c", { gh: () => null, origin }), null);
  assert.equal(ciNotGreen(SHA, "/c", { gh: () => "not json", origin }), null);
  assert.equal(ciNotGreen(SHA, "/c", { gh: () => "{}", origin }), null);
  assert.equal(ciNotGreen(SHA, "/c", { gh: () => reply(run("a", "completed", "failure")), origin: () => null }), null);
  assert.equal(ciNotGreen(null, "/c", { gh: () => reply(run("a", "completed", "failure")), origin }), null);
});
