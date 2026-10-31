import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

test("limitFileOf uses the override or its private folder in the temporary directory", async () => {
  const { limitFileOf } = await limit();
  assert.equal(limitFileOf({ QC_CODEX_LIMIT_FILE: "custom.json" }, "tmp"), "custom.json");
  const folder = `codex-${process.getuid?.() ?? os.userInfo().username}`;
  assert.equal(limitFileOf({}, "tmp"), path.join("tmp", "architecture-kit", folder, "codex-limit.json"));
  assert.equal(limitFileOf({ QC_CODEX_LIMIT_FILE: "" }, "tmp"), path.join("tmp", "architecture-kit", folder, "codex-limit.json"));
});

test("the private limit folder works under a group-writable shared parent", { skip: process.platform === "win32" }, async (t) => {
  const { limitFileOf, readLimit, writeLimit } = await limit();
  const { dir } = setup(t);
  const parent = path.join(dir, "architecture-kit");
  mkdirSync(parent);
  chmodSync(parent, 0o775);
  const file = limitFileOf({}, dir);
  writeLimit(file, { until: T + 1000, source: "codex" }, T);
  assert.deepEqual(readLimit(file, T), { until: new Date(T + 1000), source: "codex" });
  assert.equal(statSync(parent).mode & 0o777, 0o775);
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
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

test("resetTimeOf parses seconds and abbreviated relative units", async () => {
  const { resetTimeOf } = await limit();
  for (const [duration, milliseconds] of [
    ["20s", 20_000], ["20 seconds", 20_000], ["1 SECOND", 1000],
    ["1h 2m 3s", 3_723_000], ["2 hours 13 minutes 20 seconds", 8_000_000],
  ]) {
    assert.equal(resetTimeOf(`rate limit: try again in ${duration}`, T), T + milliseconds, duration);
  }
});

for (const [duration, seconds] of [["1.898s", 2], ["500ms", 1], ["6m0s", 360], ["1h2m3s", 3723]]) {
  test(`resetTimeOf parses ${duration} and rounds up to a whole second`, async () => {
    const { resetTimeOf } = await limit();
    assert.equal(resetTimeOf(`try again in ${duration}`, T), T + seconds * 1000);
  });
}

test("resetTimeOf ignores organization IDs before the last retry hint", async () => {
  const { resetTimeOf } = await limit();
  const line = "Rate limit reached for gpt-4o in organization org-3h7Kq2s9xYz on tokens per min (TPM). Please try again in 1.898s.";
  assert.equal(resetTimeOf(line, T), T + 2000);
  assert.equal(resetTimeOf("Try again in 3h. TRY AGAIN IN 500ms.", T), T + 1000);
  assert.equal(resetTimeOf("Rate limit in 3h without a retry hint.", T), null);
});

test("resetTimeOf excludes durations embedded in IDs or decimal fragments", async () => {
  const { resetTimeOf } = await limit();
  for (const fragment of ["org-3h7Kq2s9xYz", "abc20s", ".898s", "1.2.3s", "é20s", "3h7K"]) {
    assert.equal(resetTimeOf(`Try again in ${fragment}.`, T), null, fragment);
    assert.equal(resetTimeOf(`Try again in ${fragment}; 500ms.`, T), T + 1000, fragment);
  }
});

test("resetTimeOf uses today or tomorrow for a bare clock time", async () => {
  const { resetTimeOf } = await limit();
  const morning = new Date(2026, 9, 26, 10).getTime();
  const evening = new Date(2026, 9, 26, 20).getTime();
  assert.equal(resetTimeOf("Try again at 3:12 PM.", morning), new Date(2026, 9, 26, 15, 12).getTime());
  assert.equal(resetTimeOf("Try again at 3:12 PM.", evening), new Date(2026, 9, 27, 15, 12).getTime());
});

for (const line of ["You have hit your usage limit", "Try again at a mystery time.", "Try again at Oct 20th, 2026 3:12 PM."]) {
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
  if (process.platform !== "win32") assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test("writeLimit refuses a symbolic link for its state folder", async (t) => {
  const { writeLimit } = await limit();
  const { dir, file } = setup(t);
  const target = path.join(dir, "other-user");
  mkdirSync(target);
  symlinkSync(target, path.dirname(file), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => writeLimit(file, { until: T + 1000, source: "codex" }, T), /unsafe limit folder/i);
});

test("writeLimit replaces a state-file link without changing its target", async (t) => {
  const { writeLimit, readLimit } = await limit();
  const { dir, file } = setup(t);
  mkdirSync(path.dirname(file));
  const target = path.join(dir, "target.txt");
  writeFileSync(target, "keep");
  linkSync(target, file);
  writeLimit(file, { until: T + 1000, source: "codex" }, T);
  assert.equal(readFileSync(target, "utf8"), "keep");
  assert.ok(readLimit(file, T));
});

for (const [source, suffix] of [["codex", "reset time from Codex"], ["default", "default: 60 minutes after the limit"], ["wait", "reset wait bound"]]) {
  test(`runCodexStatus prints the limit with source ${source} and returns zero`, async (t) => {
    const { readLimit, runCodexStatus, writeLimit } = await limit();
    const { file } = setup(t);
    writeLimit(file, { until: T + 3_600_000, source }, T);
    assert.deepEqual(readLimit(file, T), { until: new Date(T + 3_600_000), source });
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
