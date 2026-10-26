import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const T = Date.UTC(2026, 9, 26);
const limit = () => import("./codex-limit.mjs");
const QC = fileURLToPath(new URL("./qc.mjs", import.meta.url));

function setup(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-codex-limit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, "state", "limit.json") };
}

test("limitFileOf uses the override or the architecture-kit folder in the temporary directory", async () => {
  const { limitFileOf } = await limit();
  assert.equal(limitFileOf({ QC_CODEX_LIMIT_FILE: "custom.json" }, "tmp"), "custom.json");
  assert.equal(limitFileOf({}, "tmp"), path.join("tmp", "architecture-kit", "codex-limit.json"));
});

test("resetTimeOf adds every relative day, hour, and minute unit regardless of case", async () => {
  const { resetTimeOf } = await limit();
  assert.equal(resetTimeOf("Try again in 2 hours 13 minutes.", T), T + 133 * 60_000);
  assert.equal(resetTimeOf("TRY AGAIN IN 1 DAY 2 HOURS 3 MINUTES 4 minutes.", T), T + 1567 * 60_000);
});

test("resetTimeOf parses an absolute date with an ordinal suffix and a trailing period", async () => {
  const { resetTimeOf } = await limit();
  assert.equal(resetTimeOf("try again at Oct 29th, 2026 3:12 PM.", T), new Date("Oct 29, 2026 3:12 PM").getTime());
});

test("resetTimeOf uses today or tomorrow for a bare clock time", async () => {
  const { resetTimeOf } = await limit();
  const morning = new Date(2026, 9, 26, 10).getTime();
  const evening = new Date(2026, 9, 26, 20).getTime();
  assert.equal(resetTimeOf("Try again at 3:12 PM.", morning), new Date(2026, 9, 26, 15, 12).getTime());
  assert.equal(resetTimeOf("Try again at 3:12 PM.", evening), new Date(2026, 9, 27, 15, 12).getTime());
});

for (const line of ["You have hit your usage limit", "Try again at a mystery time.", "Try again at Oct 25th, 2026 3:12 PM."]) {
  test(`resetTimeOf returns null for ${line}`, async () => {
    const { resetTimeOf } = await limit();
    assert.equal(resetTimeOf(line, T), null);
  });
}

test("readLimit returns null for a missing file, bad JSON, an invalid shape, or an expired time", async (t) => {
  const { readLimit } = await limit();
  const { dir } = setup(t);
  const file = path.join(dir, "limit.json");
  assert.equal(readLimit(file, T), null);
  for (const value of ["bad json", "null", "{}", '{"until":"invalid"}', JSON.stringify({ until: new Date(T).toISOString(), source: "codex" })]) {
    writeFileSync(file, value);
    assert.equal(readLimit(file, T), null, value);
  }
  assert.equal(readLimit(dir, T), null);
});

test("writeLimit creates the folder and stores ISO times, and readLimit returns a Date and source", async (t) => {
  const { readLimit, writeLimit } = await limit();
  const { file } = setup(t);
  const until = T + 3_600_000;
  writeLimit(file, { until, source: "codex" }, T);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    until: new Date(until).toISOString(), source: "codex", recordedAt: new Date(T).toISOString(),
  });
  assert.deepEqual(readLimit(file, T), { until: new Date(until), source: "codex" });
});

for (const [source, suffix] of [["codex", "reset time from Codex"], ["default", "default: 60 minutes after the limit"]]) {
  test(`runCodexStatus prints the limit with source ${source} and returns zero`, async (t) => {
    const { runCodexStatus, writeLimit } = await limit();
    const { file } = setup(t);
    writeLimit(file, { until: T + 3_600_000, source }, T);
    const lines = [];
    assert.equal(runCodexStatus([], { env: { QC_CODEX_LIMIT_FILE: file }, now: T, out: (line) => lines.push(line) }), 0);
    assert.deepEqual(lines, [`Codex: limited until ${new Date(T + 3_600_000).toISOString()} (${suffix})`]);
  });
}

test("runCodexStatus prints free for missing and expired state and returns zero", async (t) => {
  const { runCodexStatus, writeLimit } = await limit();
  const { dir, file } = setup(t);
  const lines = [];
  const options = { env: {}, tmp: dir, now: T, out: (line) => lines.push(line) };
  assert.equal(runCodexStatus([], options), 0);
  writeLimit(file, { until: T - 1, source: "default" }, T - 3_600_000);
  assert.equal(runCodexStatus([], { ...options, env: { QC_CODEX_LIMIT_FILE: file } }), 0);
  assert.deepEqual(lines, ["Codex: free", "Codex: free"]);
});

test("qc codex status runs with a broken config, and other codex commands print usage and exit one", (t) => {
  const { dir, file } = setup(t);
  writeFileSync(path.join(dir, "qc.config.json"), "bad json");
  const options = { cwd: dir, env: { ...process.env, QC_CODEX_LIMIT_FILE: file }, encoding: "utf8" };
  const status = spawnSync(process.execPath, [QC, "codex", "status"], options);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout.trim(), "Codex: free");
  for (const rest of [[], ["unknown"]]) {
    const result = spawnSync(process.execPath, [QC, "codex", ...rest], options);
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /qc codex status/);
  }
});
