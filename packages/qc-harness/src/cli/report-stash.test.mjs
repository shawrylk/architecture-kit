import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { dropReport, keepReport, keptReport, reportOf } from "./report-stash.mjs";

function tmp(t) {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-report-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a kept hand-back is read back until it is dropped", (t) => {
  const dir = tmp(t);
  assert.equal(keptReport("s", "agent-1", dir), null);
  keepReport("s", "agent-1", "VERDICT: APPROVED abc1234\nall good", dir);
  assert.equal(keptReport("s", "agent-1", dir), "VERDICT: APPROVED abc1234\nall good");
  assert.equal(keptReport("s", "agent-2", dir), null);
  dropReport("s", "agent-1", dir);
  assert.equal(keptReport("s", "agent-1", dir), null);
});

test("reportOf prefers the kept hand-back over the closing text of the stop", (t) => {
  const dir = tmp(t);
  const stop = { session_id: "s", agent_id: "agent-1", last_assistant_message: "Done." };
  assert.equal(reportOf(stop, dir), "Done.");
  keepReport("s", "agent-1", "RED: x\nGREEN: y", dir);
  assert.equal(reportOf(stop, dir), "RED: x\nGREEN: y");
  assert.equal(reportOf({ session_id: "s", last_assistant_message: "main" }, dir), "main");
  assert.equal(reportOf({ session_id: "s", agent_id: "agent-9" }, dir), "");
});

const reportFile = (dir, session, agent) => path.join(dir, "architecture-kit", "reports", session, `${agent}.txt`);

test("keepReport caps the text at 256 KB and keeps the end", (t) => {
  const dir = tmp(t);
  const cap = 256 * 1024;
  keepReport("s", "agent-1", `${"a".repeat(cap)}${"b".repeat(1000)}`, dir);
  const kept = keptReport("s", "agent-1", dir);
  assert.equal(Buffer.byteLength(kept), cap);
  assert.ok(kept.endsWith("b".repeat(1000)));
  keepReport("s", "agent-2", "short", dir);
  assert.equal(keptReport("s", "agent-2", dir), "short");
});

test("keepReport deletes stash files older than a day and keeps newer ones", (t) => {
  const dir = tmp(t);
  keepReport("old", "agent-1", "old", dir);
  keepReport("new", "agent-1", "new", dir);
  const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(reportFile(dir, "old", "agent-1"), past, past);
  keepReport("s", "agent-1", "now", dir);
  assert.equal(existsSync(reportFile(dir, "old", "agent-1")), false);
  assert.equal(keptReport("new", "agent-1", dir), "new");
  assert.equal(keptReport("s", "agent-1", dir), "now");
});

test("a read or write error never throws, and reportOf falls back to the last message", (t) => {
  const dir = tmp(t);
  mkdirSync(reportFile(dir, "s", "agent-1"), { recursive: true });
  assert.equal(keptReport("s", "agent-1", dir), null);
  const stop = { session_id: "s", agent_id: "agent-1", last_assistant_message: "Done." };
  assert.equal(reportOf(stop, dir), "Done.");
  assert.doesNotThrow(() => keepReport("s", "agent-1", "text", dir));
  const notADir = path.join(dir, "file");
  writeFileSync(notADir, "x");
  assert.doesNotThrow(() => keepReport("s", "agent-2", "text", notADir));
  assert.equal(keptReport("s", "agent-2", notADir), null);
  assert.equal(reportOf({ ...stop, agent_id: "agent-2" }, notADir), "Done.");
});
