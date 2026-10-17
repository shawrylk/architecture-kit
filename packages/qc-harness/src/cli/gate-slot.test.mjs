import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { claimSlot, freeStale, gateSlotDirOf, isAlive, runGateSlot } from "./gate-slot.mjs";

function slotDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-gate-slot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const holder = (pid, startedAt) => JSON.stringify({ pid, startedAt: new Date(startedAt).toISOString(), cwd: "x", command: "pnpm check:local" });

test("the folder is machine-wide under the temp folder, and QC_GATE_SLOT_DIR moves it", () => {
  assert.equal(gateSlotDirOf({}, "/tmp"), path.join("/tmp", "architecture-kit", "gate-slots"));
  assert.equal(gateSlotDirOf({ QC_GATE_SLOT_DIR: "/slots" }, "/tmp"), "/slots");
});

test("this process is alive, and an id that is no number is not", () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(Number.NaN), false);
});

test("a claim whose process is gone, or that outlived the limit, is freed; a live one stays", (t) => {
  const dir = slotDir(t);
  const now = Date.parse("2026-01-01T12:00:00Z");
  writeFileSync(path.join(dir, "slot-0.json"), holder(111, now));
  writeFileSync(path.join(dir, "slot-1.json"), holder(222, now - 121 * 60_000));
  writeFileSync(path.join(dir, "slot-2.json"), holder(333, now));
  const freed = freeStale(dir, now, 120, (pid) => pid !== 111);
  assert.deepEqual(freed.map((claim) => claim.index).sort(), [0, 1]);
  assert.deepEqual(readdirSync(dir), ["slot-2.json"]);
});

test("a claim takes the first free slot, and a full set returns null", (t) => {
  const dir = slotDir(t);
  assert.ok(claimSlot(dir, 2, { pid: 1 }).endsWith("slot-0.json"));
  assert.ok(claimSlot(dir, 2, { pid: 2 }).endsWith("slot-1.json"));
  assert.equal(claimSlot(dir, 2, { pid: 3 }), null);
});

test("a dead holder's slot is freed for the next run, which frees its own slot when the command ends", async (t) => {
  const dir = slotDir(t);
  writeFileSync(path.join(dir, "slot-0.json"), holder(999999, Date.now()));
  const ran = [];
  const code = await runGateSlot(["--slots", "1", "--", "pnpm", "check:local"], {
    env: { QC_GATE_SLOT_DIR: dir },
    alive: (pid) => pid !== 999999,
    run: async (command) => {
      ran.push(command);
      assert.ok(existsSync(path.join(dir, "slot-0.json")));
      return 4;
    },
    say: () => {},
  });
  assert.equal(code, 4);
  assert.deepEqual(ran, ["pnpm check:local"]);
  assert.deepEqual(readdirSync(dir), []);
});

test("a full set waits until a slot frees", async (t) => {
  const dir = slotDir(t);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "slot-0.json"), holder(555, Date.now()));
  let alive = true;
  const said = [];
  const code = await runGateSlot(["--slots", "1", "--", "node", "-v"], {
    env: { QC_GATE_SLOT_DIR: dir },
    alive: () => alive,
    sleep: async () => {
      alive = false;
    },
    run: async () => 0,
    say: (line) => said.push(line),
  });
  assert.equal(code, 0);
  assert.match(said.join("\n"), /all 1 slots are held/);
});

test("--status lists each holder, and a missing command is a usage error", async (t) => {
  const dir = slotDir(t);
  writeFileSync(path.join(dir, "slot-0.json"), holder(process.pid, Date.now()));
  const said = [];
  assert.equal(await runGateSlot(["--status"], { env: { QC_GATE_SLOT_DIR: dir }, say: (line) => said.push(line) }), 0);
  assert.match(said.join("\n"), new RegExp(`slot-0 +pid ${process.pid}`));
  assert.equal(await runGateSlot([], { env: { QC_GATE_SLOT_DIR: dir }, say: () => {} }), 2);
});
