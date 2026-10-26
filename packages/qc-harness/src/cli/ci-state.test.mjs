import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ciNotGreen, ciState, notGreenReason } from "./ci-state.mjs";

const SHA = "a".repeat(40);
const run = (name, status, conclusion = null) => ({ name, status, conclusion });
const reply = (...runs) => JSON.stringify({ total_count: runs.length, check_runs: runs, workflow_runs: [] });

const ciGh = (checks, workflows) => (args) => args[1].includes("/actions/runs") ? JSON.stringify(workflows) : reply(...checks);

test("unfinished workflows on the head are pending before checks exist and after checks pass", () => {
  for (const status of ["queued", "in_progress", "waiting", "pending", "requested"]) {
    for (const checks of [[], [run("lint", "completed", "success")]]) {
      const calls = [];
      const read = ciGh(checks, [{ workflow_runs: [] }, { workflow_runs: [{ name: "CI", head_sha: SHA, status }] }]);
      const gh = (args, options) => (calls.push({ args, options }), read(args));
      const state = ciState(SHA, "/c", { gh, origin: () => "o/r" });
      assert.equal(state.pending, true);
      assert.equal(state.unknown, null);
      assert.equal(state.reason, `CI on aaaaaaa: CI is ${status}`);
      assert.ok(calls[1].args.includes("--paginate"));
      assert.ok(calls[1].args.includes("--slurp"));
      assert.equal(calls[1].args[1], `repos/o/r/actions/runs?head_sha=${SHA}&per_page=100`);
      assert.ok(calls[0].options.timeoutMs + calls[1].options.timeoutMs + 1000 < 10000);
    }
  }
});

test("completed workflows and workflows on other heads add no pending state", () => {
  const gh = ciGh([run("lint", "completed", "success")], [{ workflow_runs: [
    { name: "CI", head_sha: "b".repeat(40), status: "queued" },
    { name: "CI", head_sha: SHA, status: "completed" },
  ] }]);
  assert.deepEqual(ciState(SHA, "/c", { gh, origin: () => "o/r" }), { reason: null, unknown: null });
});

test("a failed check wins over queued workflows and missing required checks", () => {
  const gh = ciGh([run("build", "completed", "failure")], [{ workflow_runs: [{ name: "CI", head_sha: SHA, status: "queued" }] }]);
  const state = ciState(SHA, "/c", { gh, origin: () => "o/r", requiredChecks: ["lint"] });
  assert.equal(state.reason, "CI on aaaaaaa: build ended failure");
  assert.equal(state.pending, undefined);
});

test("unreadable workflow lists keep a green-looking head unknown", () => {
  for (const answer of [null, "not JSON", "{}", '[{"workflow_runs":[]},{}]']) {
    const gh = (args) => args[1].includes("/actions/runs") ? answer : reply(run("lint", "completed", "success"));
    assert.match(ciState(SHA, "/c", { gh, origin: () => "o/r" }).unknown ?? "", /gh/);
  }
});

test("unreadable workflows preserve pending and failed checks", () => {
  for (const answer of [null, "not JSON", "{}", '[{"workflow_runs":[]},{}]']) {
    for (const [status, conclusion] of [["in_progress", null], ["completed", "failure"]]) {
      const gh = (args) => args[1].includes("/actions/runs") ? answer : reply(run("build", status, conclusion));
      assert.deepEqual(ciState(SHA, "/c", { gh, origin: () => "o/r" }), {
        reason: `CI on aaaaaaa: build ${status === "completed" ? "ended failure" : "is in_progress"}`,
        unknown: null,
        ...(status === "completed" ? {} : { pending: true }),
      });
    }
  }
});

test("workflow paths let a newer suite supersede a cancelled suite", () => {
  const checks = [
    { ...run("build", "completed", "cancelled"), check_suite: { id: 1 }, id: 1 },
    { ...run("build", "completed", "success"), check_suite: { id: 2 }, id: 2 },
  ];
  const workflows = checks.map((check) => ({ check_suite_id: check.check_suite.id, path: ".github/workflows/ci.yml", head_sha: SHA, status: "completed" }));
  assert.deepEqual(ciState(SHA, "/c", { gh: ciGh(checks, { workflow_runs: workflows }), origin: () => "o/r" }), { reason: null, unknown: null });
});

test("ciState uses caller-required checks and ignores invalid checkout configuration", (t) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "qc-ci-required-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(path.join(cwd, "qc.config.json"), JSON.stringify({ ci: null }));
  for (const checks of [[], [run("lint", "completed", "success")]]) {
    const state = ciState(SHA, cwd, { gh: ciGh(checks, [{ workflow_runs: [] }]), origin: () => "o/r", requiredChecks: ["build"] });
    assert.equal(state.pending, true);
    assert.equal(state.reason, "CI on aaaaaaa: build is missing");
  }
  assert.deepEqual(ciState(SHA, cwd, { gh: ciGh([run("build", "completed", "success")], [{ workflow_runs: [] }]), origin: () => "o/r" }), { reason: null, unknown: null });
  assert.deepEqual(ciState(SHA, cwd, { gh: ciGh([run("lint", "completed", "success")], [{ workflow_runs: [] }]), origin: () => "o/r" }), { reason: null, unknown: null });
});

test("checks with the same name in different suites remain separate", () => {
  const failed = { ...run("build", "completed", "failure"), check_suite: { id: 1 }, started_at: "2026-01-01", id: 1 };
  const passed = { ...run("build", "completed", "success"), check_suite: { id: 2 }, started_at: "2026-01-02", id: 2 };
  for (const runs of [[failed, passed], [passed, failed]]) assert.equal(notGreenReason(runs), "build ended failure");
});

test("ciState reads every check-run page", () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    return JSON.stringify([
      { check_runs: [run("lint", "completed", "success")] },
      { check_runs: [run("build", "completed", "failure")] },
    ]);
  };
  assert.equal(ciState(SHA, "/c", { gh, origin: () => "o/r" }).reason, "CI on aaaaaaa: build ended failure");
  assert.ok(calls[0].includes("--paginate"));
  assert.ok(calls[0].includes("--slurp"));
  assert.match(calls[0][1], /[?&]filter=all(?:&|$)/);
});

test("a queued rerun without a start time supersedes an older completed check", () => {
  const older = { ...run("build", "completed", "success"), check_suite: { id: 1 }, started_at: "2026-01-01", id: 1 };
  const newer = { ...run("build", "queued"), check_suite: { id: 1 }, started_at: null, id: 2 };
  for (const runs of [[older, newer], [newer, older]]) assert.equal(notGreenReason(runs), "build is queued");
});

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

test("every completed conclusion outside the green allowlist fails", () => {
  for (const conclusion of ["stale", "startup_failure", "future_conclusion", "", null, undefined]) {
    assert.equal(notGreenReason([{ name: "build", status: "completed", conclusion }]), `build ended ${conclusion}`);
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
  assert.equal(calls.length, 2);
  assert.match(calls[1].args[1], /actions\/runs\?head_sha=/);
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
