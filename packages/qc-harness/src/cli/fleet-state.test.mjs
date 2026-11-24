import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { stateDir, readState, writeState, pruneSeen } from "./fleet-state.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-fleet-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  mkdirSync(path.join(root, ".git"));
  return root;
}

test("state files default to empty, round trip, and replace atomically without temporary leftovers", t => {
  const root = fixture(t);
  assert.equal(stateDir(root), path.join(root, ".git", "qc", "fleet"));
  const values = { assignments: { 238: "a1" }, questions: { q1: { text: "Ready?" } }, seen: { m1: 1234 }, queue: [{ id: "m1" }] };
  for (const [name, value] of Object.entries(values)) {
    const empty = name === "queue" ? [] : {};
    assert.deepEqual(readState(root, name), empty);
    writeState(root, name, value);
    assert.deepEqual(readState(root, name), value);
    assert.deepEqual(JSON.parse(readFileSync(path.join(stateDir(root), `${name}.json`), "utf8")), value);
    writeState(root, name, empty);
    assert.deepEqual(readState(root, name), empty);
  }
  assert.deepEqual(readdirSync(stateDir(root)).sort(), Object.keys(values).map(name => `${name}.json`).sort());
  const broken = {}; broken.cycle = broken;
  assert.throws(() => writeState(root, "queue", broken));
  assert.deepEqual(readState(root, "queue"), []);
  assert.equal(readdirSync(stateDir(root)).length, 4);
});

test("linked worktrees share the git common directory", t => {
  const root = fixture(t);
  const linked = path.join(root, "linked");
  const gitDir = path.join(root, ".git", "worktrees", "linked");
  mkdirSync(linked);
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(path.join(linked, ".git"), `gitdir: ${gitDir}\n`);
  writeFileSync(path.join(gitDir, "commondir"), "../..\n");
  assert.equal(stateDir(linked), stateDir(root));
  writeState(linked, "assignments", { 238: "a1" });
  assert.deepEqual(readState(root, "assignments"), { 238: "a1" });
});

test("only named state files are allowed and read errors are not hidden as missing", t => {
  const root = fixture(t);
  for (const name of ["../escape", "unknown", "seen.json"]) {
    assert.throws(() => readState(root, name), /state file/);
    assert.throws(() => writeState(root, name, {}), /state file/);
  }
  mkdirSync(path.join(stateDir(root), "seen.json"), { recursive: true });
  assert.throws(() => readState(root, "seen"), /EISDIR|EPERM|EACCES/);
  assert.throws(() => writeState(root, "seen", {}), /EISDIR|EPERM|EACCES/);
  assert.deepEqual(readdirSync(stateDir(root)), ["seen.json"]);
  writeFileSync(path.join(stateDir(root), "queue.json"), "{");
  assert.throws(() => readState(root, "queue"), SyntaxError);
  const outside = path.join(root, "outside"); mkdirSync(outside);
  assert.throws(() => stateDir(outside), /git common dir/);
});

test("seen pruning removes only entries older than ten minutes and persists", t => {
  const root = fixture(t);
  const now = 1_000_000;
  const seen = { old: now - 600_001, edge: now - 600_000, fresh: now, future: now + 1 };
  const pruned = pruneSeen(seen, now);
  assert.deepEqual(pruned, { edge: now - 600_000, fresh: now, future: now + 1 });
  assert.equal(seen.old, now - 600_001);
  writeState(root, "seen", pruned);
  assert.deepEqual(readState(root, "seen"), pruned);
  assert.deepEqual(pruneSeen({}, now), {});
});
