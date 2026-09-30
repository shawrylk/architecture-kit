import { strict as assert } from "node:assert";
import { test } from "node:test";
import { contextDefaults } from "../config.mjs";
import { LEVELS, callsLeft, contextSettings, contextVerdict, estimateOf, handbackStamp } from "./context-signal.mjs";

const settings = contextSettings();
const IMPL = "architecture:sdd-implementer";
const facts = (context, extra = {}) => ({ context, first: 40_000, count: 10, budget: 100, estimate: null, agentType: IMPL, fired: null, ...extra });

test("the signal is on with the defaults, and `false` turns it off", () => {
  assert.deepEqual(contextSettings(), contextDefaults);
  assert.deepEqual(contextSettings({ context: {} }), contextDefaults);
  assert.equal(contextSettings({ context: false }), null);
  assert.equal(contextSettings({ context: { every: 1 } }).every, 1);
  assert.deepEqual(contextSettings({ context: { handoffTypes: ["x"] } }).handoffTypes, ["x"]);
});

test("a wrong key is a named config error", () => {
  for (const context of [{ every: 0 }, { minCallsLeft: 1.5 }, { summarizeRatio: 1 }, { handoffRatio: 2 }, { handoffTypes: "x" }, "on"]) {
    assert.throws(() => contextSettings({ context }), /swarm\.context/, JSON.stringify(context));
  }
});

test("the calls left run to the prompt's estimate while the count is under it, else to the budget", () => {
  assert.equal(callsLeft({ count: 10, budget: 100 }), 90);
  assert.equal(callsLeft({ count: 10, budget: 100, estimate: 30 }), 20);
  assert.equal(callsLeft({ count: 40, budget: 100, estimate: 30 }), 60);
  assert.equal(callsLeft({ count: 120, budget: 100 }), 0);
});

test("an estimate line is read with or without bold", () => {
  assert.equal(estimateOf("Brief: x\nEstimate: 25\n"), 25);
  assert.equal(estimateOf("**Estimate:** 30 tool calls"), 30);
  assert.equal(estimateOf("no line"), null);
  assert.equal(estimateOf(null), null);
});

test("under summarizeRatio times the first call there is nothing to say", () => {
  assert.equal(contextVerdict(facts(119_000), settings), null);
});

test("at summarizeRatio times the note says new output adds to every later call", () => {
  const verdict = contextVerdict(facts(120_000), settings);
  assert.equal(verdict.level, "summarize");
  assert.match(verdict.text, /re-sends about 120K tokens, 3\.0x its first call \(40K\)/);
  assert.match(verdict.text, /line range/);
  assert.doesNotMatch(verdict.text, /HANDOFF/);
});

test("at handoffRatio times, with work left, a hand-off type gets the hand-off steps", () => {
  const verdict = contextVerdict(facts(200_000), settings);
  assert.equal(verdict.level, "handoff");
  assert.match(verdict.text, /about 90 calls of work left/);
  assert.match(verdict.text, /`HANDOFF: <note path>`/);
  assert.match(verdict.text, /`handoffs\/`/);
});

test("too few calls left, or another type, keeps the note at summarize", () => {
  assert.equal(contextVerdict(facts(200_000, { count: 90 }), settings).level, "summarize");
  assert.equal(contextVerdict(facts(200_000, { estimate: 20 }), settings).level, "summarize");
  assert.equal(contextVerdict(facts(200_000, { agentType: "architecture:sdd-reviewer" }), settings).level, "summarize");
});

test("each level fires once, and the hand-off repeats every repeatEvery calls", () => {
  assert.equal(contextVerdict(facts(130_000, { fired: { level: "summarize", at: 5 } }), settings), null);
  assert.equal(contextVerdict(facts(200_000, { fired: { level: "summarize", at: 5 } }), settings).level, "handoff");
  assert.equal(contextVerdict(facts(200_000, { count: 20, fired: { level: "handoff", at: 10 } }), settings), null);
  assert.equal(contextVerdict(facts(200_000, { count: 30, fired: { level: "handoff", at: 10 } }), settings).level, "handoff");
  assert.equal(contextVerdict(facts(130_000, { count: 90, fired: { level: "handoff", at: 10 } }), settings), null);
  assert.deepEqual(LEVELS, ["none", "summarize", "handoff"]);
});

test("a missing first or latest context says nothing", () => {
  assert.equal(contextVerdict(facts(200_000, { first: 0 }), settings), null);
  assert.equal(contextVerdict(facts(0), settings), null);
});

test("the hand-back stamp names the end context only at or over summarizeRatio", () => {
  assert.equal(handbackStamp({ context: 100_000, first: 40_000 }, settings), null);
  assert.match(handbackStamp({ context: 200_000, first: 40_000 }, settings), /^CONTEXT: this agent ended at about 200K tokens per call, 5\.0x its first call \(40K\)/);
  assert.equal(handbackStamp({ context: 200_000, first: 0 }, settings), null);
});
