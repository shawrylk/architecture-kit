import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { dispatchDefaults } from "../config.mjs";
import { claimSlot, reclaimSlot, releaseSlot, slotDirOf } from "./dispatch-slot.mjs";

function sessionDir(t, session = "s") {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "qc-dispatch-slot-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  return slotDirOf(session, tmp);
}

const settings = { ...dispatchDefaults, slotMinutes: 1 };
const withSlots = (implementerSlots) => ({ ...settings, implementerSlots });
const IMPLEMENTER = "sdd-implementer";

/** The claim files of one session folder, sorted, with no path. */
const claimFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".claim")).sort() : []);
/** What each claim file holds, sorted. */
const heldIn = (dir) => claimFiles(dir).map((name) => readFileSync(path.join(dir, name), "utf8")).sort();
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
  assert.deepEqual(heldIn(dir), ["agent:agent-a", "agent:agent-c"]);
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
  ageClaim(dir, claimFiles(dir).find((name) => readFileSync(path.join(dir, name), "utf8") === "pending:use-2"), 30_000);
  const refused = claimSlot(dir, two, Date.now(), "use-3");
  assert.ok(readFileSync(refused.slotFile, "utf8"), "pending:use-2");
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

test("a claim lands in the first slot it creates: a pre-created slot-0 sends it to slot-1 at 2, and refuses it at 1", (t) => {
  const dir = sessionDir(t);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "slot-0.claim"), "pending:other");
  assert.equal(claimSlot(dir, withSlots(2), Date.now(), "use-1"), null);
  assert.deepEqual(claimFiles(dir), ["slot-0.claim", "slot-1.claim"]);
  assert.equal(readFileSync(path.join(dir, "slot-0.claim"), "utf8"), "pending:other");
  assert.equal(readFileSync(path.join(dir, "slot-1.claim"), "utf8"), "pending:use-1");

  const one = sessionDir(t, "one");
  mkdirSync(one, { recursive: true });
  writeFileSync(path.join(one, "slot-0.claim"), "pending:other");
  const refused = claimSlot(one, withSlots(1), Date.now(), "use-1");
  assert.deepEqual(refused.holders.map((holder) => holder.id), ["other"]);
  assert.deepEqual(claimFiles(one), ["slot-0.claim"]);
});

test("every slot pre-created means the claim is refused and no file changes", (t) => {
  const dir = sessionDir(t);
  mkdirSync(dir, { recursive: true });
  for (const index of [0, 1, 2]) writeFileSync(path.join(dir, `slot-${index}.claim`), `agent:a${index}`);
  const refused = claimSlot(dir, withSlots(3), Date.now(), "use-1");
  assert.equal(refused.limit, 3);
  assert.deepEqual(heldIn(dir), ["agent:a0", "agent:a1", "agent:a2"]);
});

test("a repeat of one holder's claim leaves its slot alone and takes no second slot", (t) => {
  const dir = sessionDir(t);
  const three = withSlots(3);
  assert.equal(claimSlot(dir, three, Date.now(), "use-1"), null);
  ageClaim(dir, "slot-0.claim", 10_000);
  const aged = statSync(path.join(dir, "slot-0.claim")).mtimeMs;
  assert.equal(claimSlot(dir, three, Date.now(), "use-1"), null);
  assert.equal(statSync(path.join(dir, "slot-0.claim")).mtimeMs, aged);
  assert.deepEqual(claimFiles(dir), ["slot-0.claim"]);
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
