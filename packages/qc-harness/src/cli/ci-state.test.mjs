import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ciNotGreen, ciState, notGreenReason } from "./ci-state.mjs";

const SHA = "a".repeat(40);
const run = (name, status, conclusion = null) => ({ name, status, conclusion });
const reply = (...runs) => JSON.stringify({ total_count: runs.length, check_runs: runs });

test("a head whose check runs all completed green is green", () => {
  assert.equal(notGreenReason([run("lint", "completed", "success"), run("docs", "completed", "skipped"), run("x", "completed", "neutral")]), null);
});

test("a newer success supersedes an older failure of the same check", () => {
  const older = { ...run("build", "completed", "failure"), started_at: "2026-01-01T00:00:00Z", id: 20 };
  const newer = { ...run("build", "completed", "success"), started_at: "2026-01-02T00:00:00Z", id: 10 };
  for (const runs of [[older, newer], [newer, older]]) {
    assert.equal(notGreenReason(runs), null);
    assert.deepEqual(ciState(SHA, "/c", { gh: () => reply(...runs), origin: () => "o/r" }), { reason: null, unknown: null });
  }
});

test("a newer failure supersedes an older success of the same check", () => {
  const older = { ...run("build", "completed", "success"), started_at: "2026-01-01T00:00:00Z", id: 20 };
  const newer = { ...run("build", "completed", "failure"), started_at: "2026-01-02T00:00:00Z", id: 10 };
  for (const runs of [[older, newer], [newer, older]]) assert.equal(notGreenReason(runs), "build ended failure");
});

test("the higher run id breaks a tie in start times", () => {
  for (const conclusion of ["success", "failure"]) {
    const older = { ...run("build", "completed", conclusion === "success" ? "failure" : "success"), started_at: "2026-01-01T00:00:00Z", id: 9 };
    const newer = { ...run("build", "completed", conclusion), started_at: older.started_at, id: 10 };
    for (const runs of [[older, newer], [newer, older]]) {
      assert.equal(notGreenReason(runs), conclusion === "success" ? null : "build ended failure");
    }
  }
});

test("the newest run counts while it is in progress", () => {
  for (const conclusion of ["success", "failure"]) {
    const older = { ...run("build", "completed", conclusion), started_at: "2026-01-01T00:00:00Z", id: 20 };
    const newer = { ...run("build", "in_progress"), started_at: "2026-01-02T00:00:00Z", id: 10 };
    for (const runs of [[older, newer], [newer, older]]) assert.equal(notGreenReason(runs), "build is in_progress");
  }
});

test("a newer success for another check preserves a failure", () => {
  const failed = { ...run("build", "completed", "failure"), started_at: "2026-01-01T00:00:00Z", id: 9 };
  const passed = { ...run("lint", "completed", "success"), started_at: "2026-01-02T00:00:00Z", id: 10 };
  assert.equal(notGreenReason([failed, passed]), "build ended failure");
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

test("ciNotGreen bounds its reads so the whole gate stays under the hook's 10 second limit", () => {
  let ghOptions;
  let originTimeout;
  const gh = (_args, options) => ((ghOptions = options), null);
  const origin = (_cwd, timeoutMs) => ((originTimeout = timeoutMs), "o/r");
  assert.equal(ciNotGreen(SHA, "/c", { gh, origin }), null, "a gh that timed out leaves the head unknown, so the review refusal stands");
  assert.ok(ghOptions.timeoutMs > 0 && ghOptions.timeoutMs <= 3000, `gh timeout ${ghOptions.timeoutMs}`);
  assert.ok(originTimeout > 0 && originTimeout <= 1000, `origin timeout ${originTimeout}`);
  assert.ok(ghOptions.timeoutMs + originTimeout < 5000);
});

test("ciState separates a head that is not green, a green head, and a head it cannot read", () => {
  const origin = () => "o/r";
  const state = (gh, from = origin) => ciState(SHA, "/c", { gh, origin: from });
  assert.deepEqual(state(() => reply(run("a", "completed", "success"))), { reason: null, unknown: null });
  assert.match(state(() => reply(run("build", "in_progress"))).reason, /^CI on aaaaaaa: build is in_progress/);
  assert.match(state(() => reply()).unknown, /no check runs/);
  assert.match(state(() => null).unknown, /gh/);
  assert.match(state(() => "not json").unknown, /gh/);
  assert.match(state(() => "{}").unknown, /gh/);
  assert.match(state(() => reply(), () => null).unknown, /origin/);
  assert.match(ciState("", "/c", { gh: () => null, origin }).unknown, /no commit/);
  for (const answer of [state(() => null), state(() => reply())]) assert.equal(answer.reason, null);
});

test("ciState marks unfinished checks so a review policy can allow them", () => {
  for (const status of ["queued", "in_progress", "waiting", "pending"]) {
    const state = ciState(SHA, "/c", { gh: () => reply(run("build", status)), origin: () => "o/r" });
    assert.equal(state.pending, true);
    assert.equal(state.reason, `CI on aaaaaaa: build is ${status}`);
  }
});

test("ciState gives a failure priority over an unfinished check", () => {
  for (const conclusion of ["failure", "cancelled", "timed_out", "action_required"]) {
    const state = ciState(SHA, "/c", {
      gh: () => reply(run("lint", "in_progress"), run("build", "completed", conclusion)),
      origin: () => "o/r",
    });
    assert.equal(state.pending, undefined);
    assert.equal(state.reason, `CI on aaaaaaa: build ended ${conclusion}`);
  }
});
