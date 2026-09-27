import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { dispatchDefaults } from "../config.mjs";
import { claimSlot, reclaimSlot, releaseSlot, slotDirOf, slotFileOf } from "./dispatch-slot.mjs";

function sessionDir(t) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "qc-dispatch-slot-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  return slotDirOf("s", tmp);
}

const settings = { ...dispatchDefaults, slotMinutes: 1 };

test("the slot folder is keyed on the session, with a file-safe name", () => {
  assert.equal(slotDirOf("sess/1:a", "/tmp"), path.join("/tmp", "architecture-kit", "dispatch", "sess_1_a"));
});

test("the first claim holds the slot, and a second claim with no stop between gets the holder", (t) => {
  const dir = sessionDir(t);
  assert.equal(claimSlot(dir, settings, Date.now()), null);
  const holder = claimSlot(dir, settings, Date.now());
  assert.equal(holder.slotFile, slotFileOf(dir));
  assert.equal(holder.expiresAt.getTime() - holder.claimedAt.getTime(), 60_000);
});

test("a claim older than slotMinutes is taken over", (t) => {
  const dir = sessionDir(t);
  claimSlot(dir, settings, Date.now());
  const old = new Date(Date.now() - 120_000);
  utimesSync(slotFileOf(dir), old, old);
  assert.equal(claimSlot(dir, settings, Date.now()), null);
});

test("only an implementer's stop frees the slot, and an empty agent type frees nothing", (t) => {
  const dir = sessionDir(t);
  claimSlot(dir, settings, Date.now());
  assert.equal(releaseSlot(dir, ""), false);
  assert.equal(releaseSlot(dir, "architecture:sdd-reviewer"), false);
  assert.equal(existsSync(slotFileOf(dir)), true);
  assert.equal(releaseSlot(dir, "architecture:sdd-implementer"), true);
  assert.equal(existsSync(slotFileOf(dir)), false);
  assert.equal(claimSlot(dir, settings, Date.now()), null);
});

test("the stop reads the list recorded at the claim", (t) => {
  const dir = sessionDir(t);
  claimSlot(dir, { ...settings, implementerTypes: ["builder"] }, Date.now());
  assert.equal(releaseSlot(dir, "sdd-implementer"), false);
  assert.equal(releaseSlot(dir, "builder"), true);
});

test("a resumed implementer claims a free slot again, and a reviewer does not", (t) => {
  const dir = sessionDir(t);
  claimSlot(dir, settings, Date.now());
  releaseSlot(dir, "sdd-implementer");
  reclaimSlot(dir, "architecture:sdd-reviewer", Date.now());
  assert.equal(existsSync(slotFileOf(dir)), false);
  reclaimSlot(dir, "sdd-implementer", Date.now());
  assert.notEqual(claimSlot(dir, settings, Date.now()), null);
});

test("a session folder with no settings, or settings that do not parse, changes nothing", (t) => {
  const dir = sessionDir(t);
  mkdirSync(dir, { recursive: true });
  assert.equal(releaseSlot(dir, "sdd-implementer"), false);
  writeFileSync(path.join(dir, "settings.json"), "not json");
  assert.equal(releaseSlot(dir, "sdd-implementer"), false);
  reclaimSlot(dir, "sdd-implementer", Date.now());
  assert.equal(existsSync(slotFileOf(dir)), false);
});
