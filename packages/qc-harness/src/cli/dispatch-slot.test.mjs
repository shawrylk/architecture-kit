import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { dispatchDefaults } from "../config.mjs";
import { claimSlot, reclaimSlot, releaseSlot, slotDirOf } from "./dispatch-slot.mjs";

function sessionDir(t) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "qc-dispatch-slot-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  return slotDirOf("s", tmp);
}

const settings = { ...dispatchDefaults, slotMinutes: 1 };
const withSlots = (implementerSlots) => ({ ...settings, implementerSlots });
const IMPLEMENTER = "sdd-implementer";

/** The claim files of one session folder, sorted, with no path. */
const claimFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".claim")).sort() : []);
const ageClaim = (dir, name, ms) => {
  const old = new Date(Date.now() - ms);
  utimesSync(path.join(dir, name), old, old);
};

test("the slot folder is keyed on the session, with a file-safe name", () => {
  assert.equal(slotDirOf("sess/1:a", "/tmp"), path.join("/tmp", "architecture-kit", "dispatch", "sess_1_a"));
});

test("the first claim holds the slot, and a second claim with no stop between gets the holder", (t) => {
  const dir = sessionDir(t);
  assert.equal(claimSlot(dir, settings, Date.now()), null);
  const holder = claimSlot(dir, settings, Date.now());
  assert.equal(holder.slotFile, path.join(dir, claimFiles(dir)[0]));
  assert.equal(holder.limit, 1);
  assert.equal(holder.expiresAt.getTime() - holder.claimedAt.getTime(), 60_000);
});

test("a claim older than slotMinutes is taken over", (t) => {
  const dir = sessionDir(t);
  claimSlot(dir, settings, Date.now());
  const old = new Date(Date.now() - 120_000);
  utimesSync(path.join(dir, claimFiles(dir)[0]), old, old);
  assert.equal(claimSlot(dir, settings, Date.now()), null);
});

test("only an implementer's stop frees the slot, and an empty agent type frees nothing", (t) => {
  const dir = sessionDir(t);
  claimSlot(dir, settings, Date.now());
  assert.equal(releaseSlot(dir, ""), false);
  assert.equal(releaseSlot(dir, "architecture:sdd-reviewer"), false);
  assert.equal(claimFiles(dir).length, 1);
  assert.equal(releaseSlot(dir, "architecture:sdd-implementer"), true);
  assert.deepEqual(claimFiles(dir), []);
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
  assert.deepEqual(claimFiles(dir), []);
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
  assert.deepEqual(claimFiles(dir), []);
});

test("a claim whose settings cannot be written is released, and the error reaches the caller", (t) => {
  const dir = sessionDir(t);
  mkdirSync(path.join(dir, "settings.json"), { recursive: true });
  assert.throws(() => claimSlot(dir, settings, Date.now()));
  assert.deepEqual(claimFiles(dir), []);
});

test("the default limit is 1, and a second holder is refused with the limit and the first holder", (t) => {
  const dir = sessionDir(t);
  assert.equal(dispatchDefaults.implementerSlots, 1);
  assert.equal(claimSlot(dir, settings, Date.now(), "use-1"), null);
  const refused = claimSlot(dir, settings, Date.now(), "use-2");
  assert.equal(refused.limit, 1);
  assert.deepEqual(refused.holders.map((holder) => holder.id), ["use-1"]);
  assert.deepEqual(claimFiles(dir).length, 1);
});

test("a limit of 3 holds three claims and refuses the fourth, naming the three holders", (t) => {
  const dir = sessionDir(t);
  for (const id of ["use-1", "use-2", "use-3"]) assert.equal(claimSlot(dir, withSlots(3), Date.now(), id), null);
  const refused = claimSlot(dir, withSlots(3), Date.now(), "use-4");
  assert.equal(refused.limit, 3);
  assert.deepEqual(refused.holders.map((holder) => holder.id).sort(), ["use-1", "use-2", "use-3"]);
  assert.equal(claimFiles(dir).length, 3);
});

test("a stop frees its own holder's claim only, so one slot opens and the others stay", (t) => {
  const dir = sessionDir(t);
  const three = withSlots(3);
  for (const id of ["use-1", "use-2", "use-3"]) claimSlot(dir, three, Date.now(), id);
  for (const id of ["agent-a", "agent-b", "agent-c"]) reclaimSlot(dir, IMPLEMENTER, Date.now(), id);
  assert.equal(claimFiles(dir).length, 3);
  assert.equal(releaseSlot(dir, IMPLEMENTER, "agent-b"), true);
  assert.equal(claimFiles(dir).length, 2);
  assert.equal(claimFiles(dir).some((name) => name.includes("agent-b")), false);
  assert.equal(claimSlot(dir, three, Date.now(), "use-4"), null);
  assert.notEqual(claimSlot(dir, three, Date.now(), "use-5"), null);
});

test("a start after a dispatch binds the dispatch's claim and counts once", (t) => {
  const dir = sessionDir(t);
  const three = withSlots(3);
  claimSlot(dir, three, Date.now(), "use-a");
  reclaimSlot(dir, IMPLEMENTER, Date.now(), "agent-a");
  assert.equal(claimFiles(dir).length, 1);
  assert.equal(claimSlot(dir, three, Date.now(), "use-b"), null);
  assert.equal(claimSlot(dir, three, Date.now(), "use-c"), null);
  assert.notEqual(claimSlot(dir, three, Date.now(), "use-d"), null);
});

test("a stop with no start before it frees one waiting claim", (t) => {
  const dir = sessionDir(t);
  claimSlot(dir, withSlots(2), Date.now(), "use-1");
  claimSlot(dir, withSlots(2), Date.now(), "use-2");
  assert.equal(releaseSlot(dir, IMPLEMENTER, "agent-x"), true);
  assert.equal(claimFiles(dir).length, 1);
});

test("an expired claim frees its slot and the live claims stay", (t) => {
  const dir = sessionDir(t);
  const three = withSlots(3);
  for (const id of ["use-1", "use-2", "use-3"]) claimSlot(dir, three, Date.now(), id);
  assert.notEqual(claimSlot(dir, three, Date.now(), "use-4"), null);
  ageClaim(dir, claimFiles(dir)[0], 120_000);
  assert.equal(claimSlot(dir, three, Date.now(), "use-4"), null);
  assert.equal(claimFiles(dir).length, 3);
});

test("the refusal names the holder that expires first", (t) => {
  const dir = sessionDir(t);
  const two = withSlots(2);
  claimSlot(dir, two, Date.now(), "use-1");
  claimSlot(dir, two, Date.now(), "use-2");
  ageClaim(dir, claimFiles(dir).find((name) => name.includes("use-2")), 30_000);
  const refused = claimSlot(dir, two, Date.now(), "use-3");
  assert.ok(refused.slotFile.includes("use-2"), refused.slotFile);
  assert.equal(refused.expiresAt.getTime() - refused.claimedAt.getTime(), 60_000);
});

test("a resumed implementer takes its own slot again while one is free, and never past the limit", (t) => {
  const dir = sessionDir(t);
  const two = withSlots(2);
  claimSlot(dir, two, Date.now(), "use-1");
  reclaimSlot(dir, IMPLEMENTER, Date.now(), "agent-1");
  releaseSlot(dir, IMPLEMENTER, "agent-1");
  assert.deepEqual(claimFiles(dir), []);
  reclaimSlot(dir, IMPLEMENTER, Date.now(), "agent-1");
  assert.equal(claimFiles(dir).length, 1);
  reclaimSlot(dir, IMPLEMENTER, Date.now(), "agent-1");
  assert.equal(claimFiles(dir).length, 1);
  reclaimSlot(dir, IMPLEMENTER, Date.now(), "agent-2");
  reclaimSlot(dir, IMPLEMENTER, Date.now(), "agent-3");
  assert.equal(claimFiles(dir).length, 2);
});

test("two claims at once both hold a slot, and a repeat of one holder's claim leaves its file alone", (t) => {
  const dir = sessionDir(t);
  const three = withSlots(3);
  assert.equal(claimSlot(dir, three, Date.now(), "use-1"), null);
  assert.equal(claimSlot(dir, three, Date.now(), "use-2"), null);
  assert.equal(claimFiles(dir).length, 2);
  const file = path.join(dir, claimFiles(dir)[0]);
  const before = statSync(file).mtimeMs;
  ageClaim(dir, claimFiles(dir)[0], 10_000);
  const aged = statSync(file).mtimeMs;
  assert.notEqual(before, aged);
  assert.equal(claimSlot(dir, three, Date.now(), "use-1"), null);
  assert.equal(statSync(file).mtimeMs, aged);
  assert.equal(claimFiles(dir).length, 2);
});

test("the stop and the start read the limit recorded at the claim, and a record with no limit means 1", (t) => {
  const dir = sessionDir(t);
  claimSlot(dir, withSlots(2), Date.now(), "use-1");
  reclaimSlot(dir, IMPLEMENTER, Date.now(), "agent-1");
  reclaimSlot(dir, IMPLEMENTER, Date.now(), "agent-2");
  assert.equal(claimFiles(dir).length, 2);
  const { implementerTypes, slotMinutes } = settings;
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ implementerTypes, slotMinutes }));
  reclaimSlot(dir, IMPLEMENTER, Date.now(), "agent-3");
  assert.equal(claimFiles(dir).length, 2);
});
