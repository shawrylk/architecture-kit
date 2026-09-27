import { strict as assert } from "node:assert";
import { test } from "node:test";
import { defaults, dispatchDefaults, merge } from "../config.mjs";
import { dispatchRefusal, dispatchSettings, isImplementer, slotRefusal, typeOf } from "./dispatch.mjs";

test("a swarm section with no dispatch key keeps the guard off", () => {
  assert.equal(dispatchSettings({}), null);
  assert.equal(dispatchSettings(merge(defaults, { swarm: { toolCallBudget: 5 } }).swarm), null);
  assert.equal(dispatchSettings({ dispatch: false }), null);
  assert.equal(dispatchSettings({ dispatch: null }), null);
});

test("an empty dispatch section turns the guard on with every default", () => {
  assert.deepEqual(dispatchSettings(merge(defaults, { swarm: { dispatch: {} } }).swarm), dispatchDefaults);
});

test("a list in the section replaces its default rather than extending it", () => {
  const settings = dispatchSettings({ dispatch: { allowedTypes: ["Explore"] } });
  assert.deepEqual(settings.allowedTypes, ["Explore"]);
  assert.deepEqual(settings.implementerTypes, dispatchDefaults.implementerTypes);
});

test("a wrong value names its key", () => {
  for (const [dispatch, key] of [
    ["on", /swarm\.dispatch in qc\.config\.json must be an object/],
    [["Explore"], /swarm\.dispatch in qc\.config\.json must be an object/],
    [{ allowedTypes: "Explore" }, /swarm\.dispatch\.allowedTypes/],
    [{ implementerTypes: [""] }, /swarm\.dispatch\.implementerTypes/],
    [{ maxPromptChars: 0 }, /swarm\.dispatch\.maxPromptChars/],
    [{ slotMinutes: -1 }, /swarm\.dispatch\.slotMinutes/],
  ]) {
    assert.throws(() => dispatchSettings({ dispatch }), key, JSON.stringify(dispatch));
  }
});

const on = dispatchSettings({ dispatch: { maxPromptChars: 20 } });

test("a dispatch with neither a model nor an allowed type is refused, and the reason names both fixes", () => {
  for (const input of [{ prompt: "p" }, { subagent_type: "general-purpose", prompt: "p" }, { subagent_type: "Explore", model: "  " }]) {
    const reason = dispatchRefusal(input, on) ?? "";
    assert.match(reason, /names no model/, JSON.stringify(input));
    assert.match(reason, /swarm\.dispatch\.allowedTypes/);
    assert.match(reason, /architecture:sdd-implementer/);
  }
});

test("a named model or an allowed type passes", () => {
  assert.equal(dispatchRefusal({ subagent_type: "general-purpose", model: "sonnet", prompt: "p" }, on), null);
  assert.equal(dispatchRefusal({ model: "haiku" }, on), null);
  assert.equal(dispatchRefusal({ subagent_type: "architecture:sdd-reviewer" }, on), null);
});

test("a fork passes only as an allowed type, since it ignores the model", () => {
  assert.match(dispatchRefusal({ subagent_type: "fork", model: "haiku" }, on) ?? "", /`fork` is in swarm\.dispatch\.allowedTypes/);
  const withFork = dispatchSettings({ dispatch: { allowedTypes: ["fork"] } });
  assert.equal(dispatchRefusal({ subagent_type: "fork" }, withFork), null);
});

test("a prompt over the limit is refused, and a prompt at the limit passes", () => {
  const reason = dispatchRefusal({ model: "haiku", prompt: "x".repeat(21) }, on) ?? "";
  assert.match(reason, /21 characters/);
  assert.match(reason, /swarm\.dispatch\.maxPromptChars \(20\)/);
  assert.match(reason, /Write the brief to a file/);
  assert.equal(dispatchRefusal({ model: "haiku", prompt: "x".repeat(20) }, on), null);
});

test("the model rule comes before the length rule", () => {
  assert.match(dispatchRefusal({ prompt: "x".repeat(21) }, on) ?? "", /names no model/);
});

test("an omitted type is general-purpose, and only a listed type is an implementer", () => {
  assert.equal(typeOf({}), "general-purpose");
  assert.equal(typeOf({ subagent_type: "" }), "general-purpose");
  assert.equal(typeOf({ subagent_type: " \t" }), "general-purpose");
  assert.equal(isImplementer("architecture:sdd-implementer", on), true);
  assert.equal(isImplementer("sdd-implementer", on), true);
  assert.equal(isImplementer("architecture:sdd-reviewer", on), false);
});

test("the slot refusal names the expiry and the file that frees the slot", () => {
  const reason = slotRefusal({
    type: "sdd-implementer",
    claimedAt: new Date(0),
    expiresAt: new Date(3_600_000),
    slotFile: "/tmp/slot.claim",
  });
  assert.match(reason, /holds the one implementer slot/);
  assert.match(reason, /1970-01-01T01:00:00\.000Z/);
  assert.match(reason, /delete \/tmp\/slot\.claim/);
});
