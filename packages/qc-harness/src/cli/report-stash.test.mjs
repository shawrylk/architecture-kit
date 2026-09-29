import { strict as assert } from "node:assert";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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
