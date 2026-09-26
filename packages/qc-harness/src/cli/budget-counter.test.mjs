import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bumpCount, counterFileOf } from "./budget-counter.mjs";

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-budget-counter-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the counter file is keyed on the session and the agent, with file-safe names", () => {
  assert.equal(
    counterFileOf("sess/1", "agent:2", "/tmp"),
    path.join("/tmp", "architecture-kit", "budget", "sess_1-agent_2.json"),
  );
});

test("each bump adds one, and each agent keeps its own count", (t) => {
  const tmp = tempDir(t);
  const a = counterFileOf("s", "a", tmp);
  const b = counterFileOf("s", "b", tmp);
  assert.deepEqual([bumpCount(a), bumpCount(a), bumpCount(b), bumpCount(a)], [1, 2, 1, 3]);
  assert.deepEqual(readdirSync(path.dirname(a)).sort(), ["s-a.json", "s-b.json"]);
});

test("a counter file that does not parse starts again at one", (t) => {
  const tmp = tempDir(t);
  const file = counterFileOf("s", "a", tmp);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "not json");
  assert.equal(bumpCount(file), 1);
});
