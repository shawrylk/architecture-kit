import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseWatchArgs, runWatch } from "./watch.mjs";

const MIN = 60_000;
const RUN_HEAD = "abc1234" + "a".repeat(33);

test("the watch and CI reference sections describe pending workflows and required checks", () => {
  const reference = readFileSync(new URL("../../../../docs/reference.md", import.meta.url), "utf8");
  const watchSection = reference.slice(reference.indexOf("#### Wait on CI with bounds"), reference.indexOf("### 10."));
  assert.match(watchSection, /ci\.requiredChecks/);
  assert.match(watchSection, /--paginate/);
  assert.match(watchSection, /`success`, `neutral`, and `skipped`/);
  assert.match(watchSection, /head_sha/);
  assert.match(watchSection, /git top level/);
  assert.match(watchSection, /one warning to stderr/);
  assert.match(watchSection, /commit status never counts as a required check/);
  assert.match(watchSection, /`--run` ignores `ci\.requiredChecks`/);
  const ciSection = reference.slice(reference.indexOf('With `requireGreen: "not-red"`'), reference.indexOf("The hooks read these markers:"));
  assert.match(ciSection, /workflow and name/);
  assert.match(ciSection, /ci\.requiredChecks/);
  assert.match(ciSection, /`stale` and `startup_failure`/);
  assert.match(ciSection, /suite id/);
  assert.match(ciSection, /repository decides, never the checkout/);
  assert.match(ciSection, /commit status never counts as a required check/);
  assert.match(ciSection, /failed workflow read preserves pending or red checks/);
  const greenRow = reference.split("\n").find((line) => line.startsWith("| Green head |"));
  assert.match(greenRow, /unfinished workflows and missing required checks/);
  assert.doesNotMatch(greenRow, /A head with no check runs passes/);
});

test("qc help describes the watch SHA suffix and bad-input exit code", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./qc.mjs", import.meta.url))], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /qc watch .*--run <workflow>@<branch>\[@<sha>\]/);
  assert.match(result.stdout, /exit 0 done, 1 bad input, 4 bound/);
});

/** A clock that the sleep advances, so a bound of 55 minutes costs no time. */
function fakeClock() {
  const clock = { now: 0 };
  return { clock, now: () => clock.now, sleep: async (ms) => void (clock.now += ms) };
}

/** `answers` is a list of stdout values, one per gh call; the last one repeats. A function answer gets the arguments. `null` is a failing gh. */
function stubGh(answers) {
  const calls = [];
  let answerIndex = 0;
  const gh = (args) => {
    calls.push(args);
    if (args[0] === "api" && args[1].includes("/actions/runs?")) return JSON.stringify([{ workflow_runs: [] }]);
    const answer = answers[Math.min(answerIndex++, answers.length - 1)];
    return typeof answer === "function" ? answer(args) : answer;
  };
  return { gh, calls };
}

const rollup = (head, ...checks) => JSON.stringify({ headRefOid: head, statusCheckRollup: checks });
const check = (name, status, conclusion = "") => ({ __typename: "CheckRun", name, status, conclusion });

async function watch(argv, { gh, time = fakeClock(), cwd, requiredChecks = cwd === undefined ? [] : undefined } = {}) {
  const lines = [];
  const warnings = [];
  const code = await runWatch(argv, { gh, requiredChecks, cwd, say: (line) => lines.push(line), warn: (line) => warnings.push(line), now: time.now, sleep: time.sleep });
  return { code, lines, warnings, time };
}

test("parseWatchArgs reads repeated flags and the defaults", () => {
  const parsed = parseWatchArgs(["--pr", "7", "--pr", "8", "--codex", "a.log", "--run", "ci.yml@feat/x", "--repo", "o/r"]);
  assert.deepEqual(parsed.prs, [7, 8]);
  assert.equal(parsed.codex.length, 1);
  assert.deepEqual(parsed.runs, [{ workflow: "ci.yml", branch: "feat/x", sha: undefined }]);
  assert.deepEqual(parseWatchArgs(["--run", "ci.yml@feat/x@abc1234"]).runs, [{ workflow: "ci.yml", branch: "feat/x", sha: "abc1234" }]);
  assert.equal(parsed.repo, "o/r");
  assert.equal(parsed.maxMinutes, 55);
  assert.equal(parsed.intervalSeconds, 60);
});

test("parseWatchArgs refuses no item, a bad number, a bad run, and an unknown flag", () => {
  assert.throws(() => parseWatchArgs([]), /--pr/);
  assert.throws(() => parseWatchArgs(["--pr", "x"]), /--pr/);
  assert.throws(() => parseWatchArgs(["--pr", "1", "--max", "0"]), /--max/);
  assert.throws(() => parseWatchArgs(["--run", "ci.yml"]), /--run/);
  assert.throws(() => parseWatchArgs(["--run", "ci.yml@"]), /--run/);
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

test("--pr rejects every completed conclusion outside the green allowlist", async () => {
  for (const conclusion of ["STALE", "STARTUP_FAILURE", "FUTURE_CONCLUSION", "", null, undefined]) {
    const { gh } = stubGh([rollup("h", check("build", "COMPLETED", conclusion))]);
    assert.equal((await watch(["--pr", "7"], { gh })).code, 5, String(conclusion));
  }
});

test("--pr waits for head workflows even when every visible check passes", async () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === "pr") return rollup("abc1234", check("lint", "COMPLETED", "SUCCESS"));
    return JSON.stringify([{ workflow_runs: [] }, { workflow_runs: [{ name: "CI", head_sha: "abc1234", status: "queued" }] }]);
  };
  assert.equal((await watch(["--pr", "7", "--repo", "o/r", "--max", "1"], { gh })).code, 4);
  assert.equal(calls[1][1], "repos/o/r/actions/runs?head_sha=abc1234&per_page=100");
  assert.ok(calls[1].includes("--paginate"));
  assert.ok(calls[1].includes("--slurp"));
});

test("--pr waits for missing required checks and passes when they appear", async () => {
  const { gh } = stubGh([rollup("h", check("lint", "COMPLETED", "SUCCESS"))]);
  assert.equal((await watch(["--pr", "7", "--max", "1"], { gh, requiredChecks: ["build"] })).code, 4);
  const ready = stubGh([rollup("h", check("build", "COMPLETED", "SUCCESS"))]);
  assert.equal((await watch(["--pr", "7"], { gh: ready.gh, requiredChecks: ["build"] })).code, 0);
});

test("a commit status cannot satisfy a required check-run name", async () => {
  const { gh } = stubGh([rollup("h", check("lint", "COMPLETED", "SUCCESS"), { __typename: "StatusContext", context: "build", state: "SUCCESS" })]);
  assert.equal((await watch(["--pr", "7", "--max", "1"], { gh, requiredChecks: ["build"] })).code, 4);
});

test("watch reads required checks at the git top level only for the local repository", async (t) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "qc-watch-config-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, ".git"));
  const nested = path.join(cwd, "nested");
  mkdirSync(nested);
  writeFileSync(path.join(cwd, "qc.config.json"), JSON.stringify({ ci: { requiredChecks: ["build"] } }));
  writeFileSync(path.join(nested, "qc.config.json"), JSON.stringify({ ci: null }));
  const { gh } = stubGh([rollup("h", check("lint", "COMPLETED", "SUCCESS"))]);
  const local = await watch(["--pr", "7", "--max", "1"], { cwd: nested, gh });
  assert.equal(local.code, 4);
  assert.deepEqual(local.warnings, []);
  const remote = await watch(["--pr", "7", "--repo", "other/repo"], { cwd: nested, gh });
  assert.equal(remote.code, 0);
  assert.deepEqual(remote.warnings, []);
});

test("an unreadable watch config warns once and continues with no required checks", async (t) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "qc-watch-bad-config-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, ".git"));
  writeFileSync(path.join(cwd, "qc.config.json"), JSON.stringify({ ci: null }));
  const { gh } = stubGh([rollup("h", check("lint", "IN_PROGRESS")), rollup("h", check("lint", "COMPLETED", "SUCCESS"))]);
  const result = await watch(["--pr", "7"], { cwd, gh });
  assert.equal(result.code, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /^watch:.*config.*ci must be an object/);
  const file = path.join(cwd, "wrapper.log");
  writeFileSync(file, "exit 0\n");
  const codex = await watch(["--codex", file], { cwd, gh });
  assert.equal(codex.code, 0);
  assert.equal(codex.warnings.length, 1);
  const remote = await watch(["--pr", "7", "--repo", "other/repo"], { cwd, gh });
  assert.equal(remote.code, 0);
  assert.deepEqual(remote.warnings, []);
});

test("--run resolves a short pinned sha and bounds every list by the full head", async () => {
  const head = "abc1234" + "a".repeat(33);
  const calls = [];
  let polls = 0;
  const gh = (args) => {
    calls.push(args);
    if (args[1].includes("/commits/")) return head;
    return JSON.stringify({ workflow_runs: [{ head_sha: head, status: ++polls === 1 ? "in_progress" : "completed", conclusion: "success" }] });
  };
  const result = await watch(["--run", "ci.yml@main@abc1234", "--repo", "o/r"], { gh });
  assert.equal(result.code, 0);
  assert.deepEqual(calls[0], ["api", "repos/o/r/commits/abc1234", "--jq", ".sha"]);
  assert.equal(calls.filter((args) => args[1].includes("/commits/")).length, 1);
  for (const args of calls.slice(1)) assert.match(args[1], new RegExp(`[?&]head_sha=${head}(?:&|$)`));
  assert.ok(calls.every((args) => !args[1].includes("commits/main")));
});

test("--pr uses the green allowlist for terminal status-context states", async () => {
  for (const state of ["SUCCESS", "NEUTRAL", "SKIPPED", "ERROR", "FUTURE_STATE"]) {
    const { gh } = stubGh([rollup("h", { __typename: "StatusContext", context: "ci", state })]);
    assert.equal((await watch(["--pr", "7"], { gh })).code, ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state) ? 0 : 5, state);
  }
});

test("--run accepts neutral and skipped workflow conclusions", async () => {
  for (const conclusion of ["neutral", "skipped"]) {
    const { gh } = stubGh([JSON.stringify([{ workflow_runs: [{ head_sha: RUN_HEAD, status: "completed", conclusion }] }])]);
    assert.equal((await watch(["--run", `ci.yml@main@${RUN_HEAD}`], { gh })).code, 0);
  }
});

test("--run waits for an unfinished head workflow on a later page", async () => {
  const { gh } = stubGh([JSON.stringify([
    { workflow_runs: [{ head_sha: RUN_HEAD, status: "completed", conclusion: "success" }] },
    { workflow_runs: [{ head_sha: RUN_HEAD, status: "queued", conclusion: null }] },
  ])]);
  assert.equal((await watch(["--run", `ci.yml@main@${RUN_HEAD}`, "--max", "1"], { gh })).code, 4);
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
  const run = (status, conclusion) => (args) => (args[1].includes("/commits/") ? "deadbeef\n" : JSON.stringify([{ workflow_runs: [{ status, conclusion, head_sha: "deadbeef" }] }]));
  const pass = stubGh([run("in_progress", ""), run("in_progress", ""), run("completed", "success")]);
  const first = await watch(["--run", "ci.yml@feat/x", "--repo", "o/r"], { gh: pass.gh });
  assert.equal(first.code, 0);
  assert.deepEqual(first.lines, ["EVENT run:ci.yml@feat/x passed deadbeef"]);
  assert.deepEqual(pass.calls[0], ["api", "repos/o/r/commits/feat%2Fx", "--jq", ".sha"]);
  assert.deepEqual(pass.calls[1], ["api", "repos/o/r/actions/workflows/ci.yml/runs?branch=feat%2Fx&head_sha=deadbeef&per_page=100", "--paginate", "--slurp"]);
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


test("a --codex wrapper that PowerShell 5.1 wrote as UTF-16LE with a BOM fires on its exit line", async (t) => {
  const file = wrapper(t);
  writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("working\r\nexit 0\r\n", "utf16le")]));
  const { code, lines } = await watch(["--codex", file], { gh: () => null });
  assert.equal(code, 0);
  assert.deepEqual(lines, [`EVENT codex:${file} exit 0`]);
});

test("a long UTF-16LE wrapper reads its tail at a character boundary", async (t) => {
  const file = wrapper(t);
  const text = `${"progress line that fills the log\r\n".repeat(200)}exit 3\r\n`;
  writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
  const { lines } = await watch(["--codex", file], { gh: () => null });
  assert.deepEqual(lines, [`EVENT codex:${file} exit 3`]);
});

test("--codex drops the partial first line of a 2 KB tail, so a cut at `exit 1` mid-line is no event", async (t) => {
  const quoted = `exit 1 is quoted in a long line${"k".repeat(2048)}`.slice(0, 2047);
  const file = wrapper(t, `${"x".repeat(300)}-${quoted}\n`);
  const { code, lines } = await watch(["--codex", file, "--max", "2"], { gh: () => null });
  assert.equal(code, 4);
  assert.deepEqual(lines, ["EVENT timeout"]);
});

test("--codex keeps a whole first line when the 2 KB cut lands on a line start", async (t) => {
  const file = wrapper(t, `${"x".repeat(100)}\nexit 4\n${"z".repeat(2041)}`);
  const { lines } = await watch(["--codex", file], { gh: () => null });
  assert.deepEqual(lines, [`EVENT codex:${file} exit 4`]);
});

test("--run reads every workflow-run page and encodes the workflow and branch", async () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    return JSON.stringify([
      { workflow_runs: [{ status: "completed", conclusion: "success", head_sha: "other99" }] },
      { workflow_runs: [{ status: "completed", conclusion: "success", head_sha: RUN_HEAD }] },
    ]);
  };
  assert.equal((await watch(["--run", `ci test.yml@feat/x@${RUN_HEAD}`, "--repo", "o/r"], { gh })).code, 0);
  assert.ok(calls[0].includes("--paginate"));
  assert.ok(calls[0].includes("--slurp"));
  assert.equal(calls[0][1], `repos/o/r/actions/workflows/ci%20test.yml/runs?branch=feat%2Fx&head_sha=${RUN_HEAD}&per_page=100`);
});

test("--run ignores a completed run on the previous head, and fires on the run of the current head", async () => {
  const time = fakeClock();
  const stale = { status: "completed", conclusion: "success", head_sha: "oldhead" };
  const fresh = { status: "completed", conclusion: "failure", head_sha: "newhead" };
  const answer = (args) => {
    if (args[1].includes("/commits/")) return "newhead\n";
    return JSON.stringify([{ workflow_runs: time.clock.now < 2 * MIN ? [stale] : [fresh, stale] }]);
  };
  const { code, lines } = await watch(["--run", "ci.yml@feat/x"], { gh: stubGh([answer]).gh, time });
  assert.equal(code, 5);
  assert.deepEqual(lines, ["EVENT run:ci.yml@feat/x failed newhead"]);
});

test("--run <wf>@<branch> never fires on a run of another head, so it times out", async () => {
  const answer = (args) => (args[1].includes("/commits/") ? "newhead\n" : JSON.stringify([{ workflow_runs: [{ status: "completed", conclusion: "success", head_sha: "oldhead" }] }]));
  const { code, lines } = await watch(["--run", "ci.yml@feat/x", "--max", "5"], { gh: stubGh([answer]).gh });
  assert.equal(code, 4);
  assert.deepEqual(lines, ["EVENT timeout"]);
});

test("--run <wf>@<branch>@<sha> pins the head and reads no branch head", async () => {
  const runs = JSON.stringify([{ workflow_runs: [
    { status: "completed", conclusion: "failure", head_sha: "other99" },
    { status: "completed", conclusion: "success", head_sha: RUN_HEAD },
  ] }]);
  const { gh, calls } = stubGh([runs]);
  const { code, lines } = await watch(["--run", `ci.yml@feat/x@${RUN_HEAD}`], { gh });
  assert.equal(code, 0);
  assert.deepEqual(lines, [`EVENT run:ci.yml@feat/x@${RUN_HEAD} passed ${RUN_HEAD}`]);
  assert.ok(calls.every((args) => args[0] === "api" && args[1].includes("/actions/workflows/")), "no branch-head read");
});

test("a gh error writes one stderr line with the first line of the error, and the wait goes on", async () => {
  let calls = 0;
  const gh = (args) => {
    if (args[0] === "api") return JSON.stringify([{ workflow_runs: [] }]);
    calls += 1;
    if (calls === 1) throw new Error("HTTP 502 bad gateway\nmore detail");
    return rollup("h", check("a", "COMPLETED", "SUCCESS"));
  };
  const { code, warnings, lines } = await watch(["--pr", "7"], { gh });
  assert.equal(code, 0);
  assert.deepEqual(warnings, ["watch: gh failed: HTTP 502 bad gateway"]);
  assert.deepEqual(lines, ["EVENT pr:7 passed h"]);
});

test("a gh that answers null writes a stderr line and is not an event", async () => {
  const { code, warnings } = await watch(["--pr", "7", "--max", "2"], { gh: () => null });
  assert.equal(code, 4);
  assert.ok(warnings.length >= 1 && warnings.every((line) => line.startsWith("watch: gh failed: ")));
});
