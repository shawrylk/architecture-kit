import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseWatchArgs, runWatch } from "./watch.mjs";

const MIN = 60_000;

/** A clock that the sleep advances, so a bound of 55 minutes costs no time. */
function fakeClock() {
  const clock = { now: 0 };
  return { clock, now: () => clock.now, sleep: async (ms) => void (clock.now += ms) };
}

/** `answers` is a list of stdout values, one per gh call; the last one repeats. A function answer gets the arguments. `null` is a failing gh. */
function stubGh(answers) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    return typeof answer === "function" ? answer(args) : answer;
  };
  return { gh, calls };
}

const rollup = (head, ...checks) => JSON.stringify({ headRefOid: head, statusCheckRollup: checks });
const check = (name, status, conclusion = "") => ({ __typename: "CheckRun", name, status, conclusion });

async function watch(argv, { gh, time = fakeClock() } = {}) {
  const lines = [];
  const code = await runWatch(argv, { gh, say: (line) => lines.push(line), now: time.now, sleep: time.sleep });
  return { code, lines, time };
}

test("parseWatchArgs reads repeated flags and the defaults", () => {
  const parsed = parseWatchArgs(["--pr", "7", "--pr", "8", "--codex", "a.log", "--run", "ci.yml@feat/x", "--repo", "o/r"]);
  assert.deepEqual(parsed.prs, [7, 8]);
  assert.equal(parsed.codex.length, 1);
  assert.deepEqual(parsed.runs, [{ workflow: "ci.yml", branch: "feat/x" }]);
  assert.equal(parsed.repo, "o/r");
  assert.equal(parsed.maxMinutes, 55);
  assert.equal(parsed.intervalSeconds, 60);
});

test("parseWatchArgs refuses no item, a bad number, a bad run, and an unknown flag", () => {
  assert.throws(() => parseWatchArgs([]), /--pr/);
  assert.throws(() => parseWatchArgs(["--pr", "x"]), /--pr/);
  assert.throws(() => parseWatchArgs(["--pr", "1", "--max", "0"]), /--max/);
  assert.throws(() => parseWatchArgs(["--run", "ci.yml"]), /--run/);
  assert.throws(() => parseWatchArgs(["--pr", "1", "--nope"]), /--nope/);
  assert.throws(() => parseWatchArgs(["--pr"]), /--pr/);
});

test("--pr exits 0 when every check completes and passes", async () => {
  const done = rollup("abc123", check("a", "COMPLETED", "SUCCESS"), check("b", "COMPLETED", "SKIPPED"));
  const { gh, calls } = stubGh([rollup("abc123", check("a", "IN_PROGRESS")), done]);
  const { code, lines } = await watch(["--pr", "7", "--repo", "o/r"], { gh });
  assert.equal(code, 0);
  assert.deepEqual(lines, ["EVENT pr:7 passed abc123"]);
  assert.deepEqual(calls[0], ["pr", "view", "7", "--json", "headRefOid,statusCheckRollup", "-R", "o/r"]);
});

test("--pr exits 5 as soon as one check fails, while others still run", async () => {
  const { gh } = stubGh([rollup("abc123", check("a", "IN_PROGRESS"), check("b", "COMPLETED", "FAILURE"))]);
  const { code, lines } = await watch(["--pr", "7"], { gh });
  assert.equal(code, 5);
  assert.deepEqual(lines, ["EVENT pr:7 failed abc123"]);
});

test("--pr counts a failed status context", async () => {
  const { gh } = stubGh([rollup("h1", { __typename: "StatusContext", context: "ci", state: "FAILURE" })]);
  assert.equal((await watch(["--pr", "7"], { gh })).code, 5);
});

test("--pr exits 6 when a job stays QUEUED past 15 minutes", async () => {
  const { gh } = stubGh([rollup("abc123", check("a", "QUEUED"))]);
  const { code, lines, time } = await watch(["--pr", "7"], { gh });
  assert.equal(code, 6);
  assert.deepEqual(lines, ["EVENT pr:7 queued abc123"]);
  assert.ok(time.clock.now > 15 * MIN && time.clock.now <= 16 * MIN, `waited ${time.clock.now}`);
});

test("a new head restarts the queued timer for that PR", async () => {
  // Head one queues for 14 minutes. Head two then queues: the timer starts over, so exit 6 comes 15 minutes later.
  const time = fakeClock();
  const { gh } = stubGh([() => rollup(time.clock.now < 14 * MIN ? "head1" : "head2", check("a", "QUEUED"))]);
  const { code, lines } = await watch(["--pr", "7"], { gh, time });
  assert.equal(code, 6);
  assert.deepEqual(lines, ["EVENT pr:7 queued head2"]);
  assert.ok(time.clock.now > 29 * MIN, `waited ${time.clock.now}`);
});

test("a failing gh read is retried, and is not an event", async () => {
  const { gh } = stubGh([null, "not json", rollup("h", check("a", "COMPLETED", "SUCCESS"))]);
  assert.equal((await watch(["--pr", "7"], { gh })).code, 0);
});

test("the bound prints EVENT timeout and exits 4", async () => {
  const { gh } = stubGh([rollup("h", check("a", "IN_PROGRESS"))]);
  const { code, lines, time } = await watch(["--pr", "7", "--max", "5"], { gh });
  assert.equal(code, 4);
  assert.deepEqual(lines, ["EVENT timeout"]);
  assert.equal(time.clock.now, 5 * MIN);
});

test("the default bound is 55 minutes", async () => {
  const { gh } = stubGh([rollup("h", check("a", "IN_PROGRESS"))]);
  const { code, time } = await watch(["--pr", "7"], { gh });
  assert.equal(code, 4);
  assert.equal(time.clock.now, 55 * MIN);
});

function wrapper(t, text) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-watch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "wrapper.log");
  if (text !== undefined) writeFileSync(file, text);
  return file;
}

test("--codex exits 0 on a line that starts with `exit `", async (t) => {
  const file = wrapper(t, "working\nmore output\nexit 2\n");
  const { code, lines } = await watch(["--codex", file], { gh: () => null });
  assert.equal(code, 0);
  assert.deepEqual(lines, [`EVENT codex:${file} exit 2`]);
});

test("--codex ignores `exit` inside a line and a missing file, then times out", async (t) => {
  const file = wrapper(t, "did not exit 1 yet\n");
  assert.equal((await watch(["--codex", file, "--max", "2"], { gh: () => null })).code, 4);
  const missing = path.join(path.dirname(file), "none.log");
  assert.equal((await watch(["--codex", missing, "--max", "2"], { gh: () => null })).code, 4);
});

test("--codex reads only the last 2 KB", async (t) => {
  const file = wrapper(t, `exit 9\n${"x".repeat(5000)}\n`);
  assert.equal((await watch(["--codex", file, "--max", "2"], { gh: () => null })).code, 4);
});

test("--run exits 0 on a success and 5 on a failure", async () => {
  const run = (status, conclusion) => JSON.stringify([{ status, conclusion, headSha: "deadbeef" }]);
  const pass = stubGh([run("in_progress", ""), run("completed", "success")]);
  const first = await watch(["--run", "ci.yml@feat/x", "--repo", "o/r"], { gh: pass.gh });
  assert.equal(first.code, 0);
  assert.deepEqual(first.lines, ["EVENT run:ci.yml@feat/x passed deadbeef"]);
  assert.deepEqual(pass.calls[0], ["run", "list", "--workflow", "ci.yml", "--branch", "feat/x", "--limit", "1", "--json", "status,conclusion,headSha", "-R", "o/r"]);
  const fail = await watch(["--run", "ci.yml@feat/x"], { gh: stubGh([run("completed", "failure")]).gh });
  assert.equal(fail.code, 5);
  assert.deepEqual(fail.lines, ["EVENT run:ci.yml@feat/x failed deadbeef"]);
});

test("the first event among several items wins", async (t) => {
  const file = wrapper(t, "exit 0\n");
  const { gh } = stubGh([rollup("h", check("a", "IN_PROGRESS"))]);
  const { code, lines } = await watch(["--pr", "7", "--codex", file], { gh });
  assert.equal(code, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^EVENT codex:/);
});
