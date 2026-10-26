import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCodexWaitReset, waitForCodexReset } from "./codex-reset.mjs";

const SINCE = "2026-01-01T00:00:00.000Z";
const INTERVAL = 30 * 60 * 1000;
const quiet = () => {};

function clock() {
  let time = Date.parse(SINCE);
  const sleeps = [];
  return {
    now: () => time,
    sleeps,
    sleep: async (ms) => { sleeps.push(ms); time += ms; },
  };
}

function response(announcedAt) {
  return { ok: true, json: async () => ({ data: { latest_reset: { announced_at: announcedAt } } }) };
}

test("a reset strictly after the limit is found on the second poll", async () => {
  const timer = clock();
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    return response(calls.length === 1 ? SINCE : "2026-01-01T00:15:00.000Z");
  };
  assert.equal(await waitForCodexReset({ since: SINCE, fetch, ...timer, say: quiet }), true);
  assert.deepEqual(calls, Array(2).fill("https://codex-resets.com/api/v1/status"));
  assert.deepEqual(timer.sleeps, [INTERVAL]);
});

test("the bound stops polling and clips the final sleep", async () => {
  const timer = clock();
  let calls = 0;
  const fetch = async () => { calls += 1; return response(SINCE); };
  assert.equal(await waitForCodexReset({ since: SINCE, maxHours: 0.6, fetch, ...timer, say: quiet }), false);
  assert.equal(calls, 2);
  assert.deepEqual(timer.sleeps, [INTERVAL, 6 * 60 * 1000]);
});

test("a fetch error keeps polling", async () => {
  const timer = clock();
  let calls = 0;
  const messages = [];
  const fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error("offline");
    return response("2026-01-01T00:15:00.000Z");
  };
  assert.equal(await waitForCodexReset({ since: SINCE, fetch, ...timer, say: (line) => messages.push(line) }), true);
  assert.equal(calls, 2);
  assert.deepEqual(timer.sleeps, [INTERVAL]);
  assert.match(messages.join("\n"), /offline/);
});

test("the standalone command exits zero on a reset and one at its bound", async () => {
  assert.equal(await runCodexWaitReset(["--since", SINCE], {
    ...clock(), fetch: async () => response("2026-01-01T00:15:00.000Z"), say: quiet,
  }), 0);
  const timer = clock();
  let calls = 0;
  assert.equal(await runCodexWaitReset(["--since", SINCE], {
    ...timer, fetch: async () => { calls += 1; return response(SINCE); }, say: quiet,
  }), 1);
  assert.equal(calls, 12);
  assert.equal(timer.now() - Date.parse(SINCE), 6 * 60 * 60 * 1000);
});

test("invalid wait arguments fail before fetching", async () => {
  for (const argv of [[], ["--since"], ["--since", "invalid"], ["--since", SINCE, "--unknown", "1"],
    ["--since", SINCE, "--max-hours"], ...["0", "-1", "Infinity", "NaN"].map((hours) => ["--since", SINCE, "--max-hours", hours])]) {
    assert.equal(await runCodexWaitReset(argv, { fetch: async () => assert.fail("no fetch"), say: quiet }), 1);
  }
});

for (const minutes of ["0.5", "7.5", "90"]) {
  test(`the standalone command polls every ${minutes} minutes`, async () => {
    const timer = clock();
    let calls = 0;
    assert.equal(await runCodexWaitReset(["--since", SINCE, "--poll-minutes", minutes], {
      ...timer, say: quiet,
      fetch: async () => response(++calls === 1 ? SINCE : "2026-01-01T00:00:01.000Z"),
    }), 0);
    assert.equal(calls, 2);
    assert.deepEqual(timer.sleeps, [Number(minutes) * 60_000]);
  });
}

test("an invalid poll interval fails before fetching with usage", async () => {
  for (const value of [undefined, "0", "-1", "Infinity", "-Infinity", "NaN", "invalid", "", " ", "1e308"]) {
    const messages = [];
    const argv = ["--since", SINCE, "--poll-minutes", ...(value === undefined ? [] : [value])];
    assert.equal(await runCodexWaitReset(argv, {
      fetch: async () => assert.fail("no fetch"), say: (line) => messages.push(line),
    }), 1);
    assert.match(messages.join("\n"), /--poll-minutes (must be a positive finite number|needs a value)/);
    assert.match(messages.join("\n"), /usage: qc codex-wait-reset/);
  }
});

test("the selected poll interval clips its final sleep at the bound", async () => {
  const timer = clock();
  let calls = 0;
  assert.equal(await runCodexWaitReset(["--since", SINCE, "--poll-minutes", "7.5", "--max-hours", "0.2"], {
    ...timer, say: quiet, fetch: async () => { calls += 1; return response(SINCE); },
  }), 1);
  assert.equal(calls, 2);
  assert.deepEqual(timer.sleeps, [7.5 * 60_000, 4.5 * 60_000]);
});

test("HTTP errors, invalid JSON, and missing reset data keep polling", async () => {
  const timer = clock();
  const responses = [
    { ok: false, status: 503 },
    { ok: true, json: async () => { throw new Error("invalid JSON"); } },
    { ok: true, json: async () => ({}) },
    response("invalid"),
    response("2026-01-01T01:00:00.000Z"),
  ];
  assert.equal(await waitForCodexReset({ since: SINCE, ...timer, fetch: async () => responses.shift(), say: quiet }), true);
  assert.equal(responses.length, 0);
  assert.deepEqual(timer.sleeps, Array(4).fill(INTERVAL));
});

test("a response after the deadline cannot resume the runner", async () => {
  const timer = clock();
  const fetch = async (_url, { signal }) => {
    assert.ok(signal instanceof AbortSignal);
    await timer.sleep(INTERVAL);
    return response("2026-01-01T00:15:00.000Z");
  };
  assert.equal(await waitForCodexReset({ since: SINCE, maxHours: 0.25, ...timer, fetch, say: quiet }), false);
});

test("the dispatcher returns after fetch and exposes the wait command in help", () => {
  const cli = new URL("./qc.mjs", import.meta.url).href;
  const source = `globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { latest_reset: { announced_at: '2026-01-01T00:15:00.000Z' } } }) });
    process.exit = () => { throw new Error('forced exit after fetch'); };
    process.argv = [process.execPath, ${JSON.stringify(cli)}, 'codex-wait-reset', '--since', ${JSON.stringify(SINCE)}];
    await import(${JSON.stringify(cli)});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const help = spawnSync(process.execPath, [fileURLToPath(new URL("./qc.mjs", import.meta.url)), "help"], { encoding: "utf8", timeout: 10000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /codex-wait-reset --since <iso> \[--max-hours <n>\]/);
  assert.match(help.stdout, /--wait-reset/);
  assert.match(help.stdout, /codex-implement[^\n]+\[--effort <low\|medium\|high>\][^\n]+\[--poll-minutes <n>\]/);
  assert.match(help.stdout, /codex-wait-reset[^\n]+\[--poll-minutes <n>\]/);
  assert.match(help.stdout, /--wait-reset polls every 30 minutes/);
});
