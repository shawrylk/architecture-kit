import { strict as assert } from "node:assert";
import { test } from "node:test";
import { defaults, dispatchDefaults, merge, runtimeModels } from "../config.mjs";
import { dispatchNote, dispatchRefusal, dispatchSettings, exploreSettings, exploreToolLines, familyOf, isImplementer, runtimeOf, slotRefusal, typeOf } from "./dispatch.mjs";

// The settings below default to Codex, whatever runtime runs the test.
process.env.QC_RUNTIME = "codex";

test("a swarm section with no dispatch key keeps the guard off", () => {
  assert.equal(dispatchSettings({}), null);
  assert.equal(dispatchSettings(merge(defaults, { swarm: { toolCallBudget: 5 } }).swarm), null);
  assert.equal(dispatchSettings({ dispatch: false }), null);
  assert.equal(dispatchSettings({ dispatch: null }), null);
});

test("an empty dispatch section turns the guard on with every default", () => {
  const expected = { ...dispatchDefaults, models: runtimeModels.codex, runtime: "codex" };
  assert.deepEqual(dispatchSettings(merge(defaults, { swarm: { dispatch: {} } }).swarm), expected);
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
    [{ implementerSlots: 0 }, /swarm\.dispatch\.implementerSlots/],
    [{ implementerSlots: -1 }, /swarm\.dispatch\.implementerSlots/],
    [{ implementerSlots: 1.5 }, /swarm\.dispatch\.implementerSlots/],
    [{ implementerSlots: "2" }, /swarm\.dispatch\.implementerSlots/],
    [{ implementerSlots: null }, /swarm\.dispatch\.implementerSlots/],
    [{ models: "opus" }, /swarm\.dispatch\.models\b/],
    [{ models: ["opus"] }, /swarm\.dispatch\.models\b/],
    [{ models: { "sdd-planner": [] } }, /swarm\.dispatch\.models\.sdd-planner/],
    [{ models: { "sdd-planner": ["gpt"] } }, /swarm\.dispatch\.models\.sdd-planner/],
  ]) {
    assert.throws(() => dispatchSettings({ dispatch }), key, JSON.stringify(dispatch));
  }
});

test("a repository's models merges key by key with the defaults", () => {
  const settings = dispatchSettings({ dispatch: { models: { "architecture:sdd-planner": ["sonnet"] } } });
  assert.deepEqual(settings.models["architecture:sdd-planner"], ["sonnet"]);
  assert.deepEqual(settings.models["architecture:sdd-implementer"], runtimeModels.codex["architecture:sdd-implementer"]);
});

test("familyOf finds the first known family a model string contains, lower-cased", () => {
  assert.equal(familyOf("sonnet"), "sonnet");
  assert.equal(familyOf("claude-sonnet-5"), "sonnet");
  assert.equal(familyOf("opus[1m]"), "opus");
  assert.equal(familyOf("OPUS"), "opus");
  assert.equal(familyOf("gpt-4"), null);
  assert.equal(familyOf("GPT-6.1-SOL"), "gpt-6.1-sol");
  assert.equal(familyOf("gpt-6.1-sol-other"), null);
});

test("every SDD role and the wildcard accept GPT 6.1 Sol by default and refuse another GPT model", () => {
  const settings = dispatchSettings({ dispatch: {} });
  for (const type of [...settings.allowedTypes, "general-purpose", "Explore"]) {
    assert.equal(dispatchRefusal({ subagent_type: type, model: "gpt-6.1-sol" }, settings), null, type);
    assert.match(dispatchRefusal({ subagent_type: type, model: "gpt-6-sol" }, settings) ?? "", /gpt-6\.1-sol/, type);
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
  assert.equal(dispatchRefusal({ subagent_type: "general-purpose", model: "gpt-6.1-sol", prompt: "p" }, on), null);
  assert.equal(dispatchRefusal({ model: "gpt-6.1-sol" }, on), null);
  assert.equal(dispatchRefusal({ subagent_type: "architecture:sdd-reviewer" }, on), null);
});

test("a fork passes only as an allowed type, since it ignores the model", () => {
  assert.match(dispatchRefusal({ subagent_type: "fork", model: "haiku" }, on) ?? "", /`fork` is in swarm\.dispatch\.allowedTypes/);
  const withFork = dispatchSettings({ dispatch: { allowedTypes: ["fork"] } });
  assert.equal(dispatchRefusal({ subagent_type: "fork" }, withFork), null);
});

test("a prompt over the limit is refused, and a prompt at the limit passes", () => {
  const reason = dispatchRefusal({ model: "gpt-6.1-sol", prompt: "x".repeat(21) }, on) ?? "";
  assert.match(reason, /21 characters/);
  assert.match(reason, /swarm\.dispatch\.maxPromptChars \(20\)/);
  assert.match(reason, /Write the brief to a file/);
  assert.equal(dispatchRefusal({ model: "gpt-6.1-sol", prompt: "x".repeat(20) }, on), null);
});

test("the model rule comes before the length rule", () => {
  assert.match(dispatchRefusal({ prompt: "x".repeat(21) }, on) ?? "", /names no model/);
});

test("a planner on sonnet is refused, and an implementer on opus is refused", () => {
  const planner = dispatchRefusal({ subagent_type: "architecture:sdd-planner", model: "sonnet" }, on) ?? "";
  assert.match(planner, /architecture:sdd-planner/);
  assert.match(planner, /"sonnet"/);
  assert.match(planner, /gpt-6\.1-sol/);
  const implementer = dispatchRefusal({ subagent_type: "architecture:sdd-implementer", model: "opus" }, on) ?? "";
  assert.match(implementer, /architecture:sdd-implementer/);
  assert.match(implementer, /"opus"/);
  assert.match(implementer, /gpt-6\.1-sol/);
});

test("a general-purpose dispatch on opus is refused, naming the wildcard's families", () => {
  const reason = dispatchRefusal({ model: "opus" }, on) ?? "";
  assert.match(reason, /general-purpose/);
  assert.match(reason, /gpt-6\.1-sol/);
});

test("a model string with no known family is refused", () => {
  assert.match(dispatchRefusal({ model: "gpt-4" }, on) ?? "", /general-purpose/);
});

test("each shipped role accepts its configured model, bare and scoped", () => {
  for (const type of on.allowedTypes) {
    assert.equal(dispatchRefusal({ subagent_type: type, model: "gpt-6.1-sol" }, on), null, type);
  }
  assert.equal(dispatchRefusal({ model: "gpt-6.1-sol" }, on), null);
});

test("a fork keeps its current rule and never reaches the tier check", () => {
  assert.match(
    dispatchRefusal({ subagent_type: "fork", model: "gpt-4" }, on) ?? "",
    /`fork` is in swarm\.dispatch\.allowedTypes/,
  );
});

test("a repository override replaces one type's families and leaves the rest at default", () => {
  const withOverride = dispatchSettings({ dispatch: { models: { "architecture:sdd-planner": ["sonnet"] } } });
  assert.equal(dispatchRefusal({ subagent_type: "architecture:sdd-planner", model: "sonnet" }, withOverride), null);
  assert.match(
    dispatchRefusal({ subagent_type: "architecture:sdd-implementer", model: "opus" }, withOverride) ?? "",
    /architecture:sdd-implementer/,
  );
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

test("implementerSlots defaults to 1, and a repository sets a whole number", () => {
  assert.equal(dispatchSettings({ dispatch: {} }).implementerSlots, 1);
  assert.equal(dispatchSettings({ dispatch: { implementerSlots: 3 } }).implementerSlots, 3);
});

test("a refusal over a limit above 1 names the limit and each holder, and one at 1 keeps its text", () => {
  const holders = [
    { id: "use-1", file: "/tmp/pending-use-1.claim", claimedAt: new Date(0) },
    { id: "agent-2", file: "/tmp/agent-agent-2.claim", claimedAt: new Date(1000) },
  ];
  const reason = slotRefusal({
    type: "sdd-implementer",
    claimedAt: new Date(0),
    expiresAt: new Date(3_600_000),
    slotFile: "/tmp/pending-use-1.claim",
    limit: 2,
    holders,
  });
  assert.match(reason, /all 2 implementer slots/);
  assert.match(reason, /use-1/);
  assert.match(reason, /agent-2/);
  assert.match(reason, /1970-01-01T01:00:00\.000Z/);
  assert.match(reason, /delete \/tmp\/pending-use-1\.claim/);
  const one = slotRefusal({
    type: "sdd-implementer",
    claimedAt: new Date(0),
    expiresAt: new Date(3_600_000),
    slotFile: "/tmp/slot.claim",
    limit: 1,
    holders: holders.slice(0, 1),
  });
  assert.match(one, /holds the one implementer slot/);
  assert.doesNotMatch(one, /use-1/);
});

test("exploreToolLines gives one `- name: use (how)` line per tool, in config order", () => {
  assert.deepEqual(
    exploreToolLines([
      { name: "CocoIndex", use: "find the files for a concept", how: 'ccc search "<question>"' },
      { name: "GitNexus", use: "callers and callees", how: "gitnexus context <symbol> -r repo" },
    ]),
    [
      '- CocoIndex: find the files for a concept (ccc search "<question>")',
      "- GitNexus: callers and callees (gitnexus context <symbol> -r repo)",
    ],
  );
  assert.deepEqual(exploreToolLines([]), []);
});

test("a shipped type that names a full model id gets a cache note, never a refusal", () => {
  const settings = { ...dispatchDefaults };
  const note = dispatchNote({ subagent_type: "architecture:sdd-implementer", model: "claude-sonnet-5", prompt: "x" }, settings);
  assert.match(note, /share no prompt cache/);
  assert.equal(dispatchNote({ subagent_type: "architecture:sdd-implementer", model: "gpt-6.1-sol", prompt: "x" }, settings), null);
  assert.equal(dispatchNote({ subagent_type: "architecture:sdd-implementer", prompt: "x" }, settings), null);
  assert.equal(dispatchNote({ subagent_type: "general-purpose", model: "claude-sonnet-5", prompt: "x" }, settings), null);
});

test("an excerptChars the repository leaves out is half of maxOutputChars, at most 4000, and never an error", () => {
  assert.equal(exploreSettings({ explore: { maxOutputChars: 20 } }).excerptChars, 10);
  assert.equal(exploreSettings({ explore: { maxOutputChars: 7 } }).excerptChars, 3);
  assert.equal(exploreSettings({ explore: { maxOutputChars: 7999 } }).excerptChars, 3999);
  assert.equal(exploreSettings({ explore: { maxOutputChars: 20000 } }).excerptChars, 4000);
  assert.equal(exploreSettings({ explore: {} }).excerptChars, 4000);
});

test("an excerptChars the repository sets must be smaller than maxOutputChars", () => {
  assert.equal(exploreSettings({ explore: { maxOutputChars: 20, excerptChars: 19 } }).excerptChars, 19);
  for (const excerptChars of [20, 21]) {
    assert.throws(() => exploreSettings({ explore: { maxOutputChars: 20, excerptChars } }), /swarm\.explore\.excerptChars .*smaller than maxOutputChars \(20\)/);
  }
});

test("the runtime comes from QC_RUNTIME, then CLAUDECODE or CLAUDE_PROJECT_DIR, then a CODEX_ variable, and is null with no signal", () => {
  assert.equal(runtimeOf({ QC_RUNTIME: "Codex", CLAUDECODE: "1" }), "codex");
  assert.equal(runtimeOf({ QC_RUNTIME: "other", CLAUDECODE: "1" }), null);
  assert.equal(runtimeOf({ CLAUDECODE: "1", CODEX_HOME: "x" }), "claude");
  assert.equal(runtimeOf({ CLAUDE_PROJECT_DIR: "/repo", CODEX_HOME: "x" }), "claude");
  assert.equal(runtimeOf({ CLAUDE_PROJECT_DIR: "", CODEX_HOME: "x" }), "codex");
  assert.equal(runtimeOf({ CODEX_HOME: "x" }), "codex");
  assert.equal(runtimeOf({}), null);
});

test("under Claude Code the no-model refusal covers only the four roles, not another type a repository lists", () => {
  const settings = dispatchSettings({ dispatch: { allowedTypes: [...dispatchDefaults.allowedTypes, "Explore"], models: { Explore: ["haiku"] } } }, "claude");
  assert.equal(dispatchRefusal({ subagent_type: "Explore", prompt: "p" }, settings), null);
});

test("under Claude Code each role takes its Claude tier, and a role dispatch must name it", () => {
  const settings = dispatchSettings({ dispatch: {} }, "claude");
  assert.equal(dispatchRefusal({ subagent_type: "architecture:sdd-implementer", model: "sonnet", prompt: "p" }, settings), null);
  assert.equal(dispatchRefusal({ subagent_type: "architecture:sdd-branch-reviewer", model: "opus", prompt: "p" }, settings), null);
  assert.match(dispatchRefusal({ subagent_type: "architecture:sdd-implementer", model: "gpt-6.1-sol" }, settings) ?? "", /may run only on sonnet/);
  assert.match(dispatchRefusal({ subagent_type: "architecture:sdd-planner", prompt: "p" }, settings) ?? "", /inherits the session's model.*Pass `model` with opus/);
  assert.equal(dispatchRefusal({ subagent_type: "Explore", model: "haiku", prompt: "p" }, settings), null);
});

test("under Codex a role dispatch with no model inherits the session's GPT model", () => {
  const settings = dispatchSettings({ dispatch: {} }, "codex");
  assert.equal(dispatchRefusal({ subagent_type: "architecture:sdd-implementer", prompt: "p" }, settings), null);
  assert.match(dispatchRefusal({ subagent_type: "architecture:sdd-implementer", model: "sonnet" }, settings) ?? "", /may run only on gpt-6\.1-sol/);
});

test("an unknown runtime refuses a named model with no listed families, and a repository's models still apply", () => {
  const unknown = dispatchSettings({ dispatch: {} }, null);
  assert.match(dispatchRefusal({ subagent_type: "architecture:sdd-implementer", model: "sonnet" }, unknown) ?? "", /runtime is unknown.*QC_RUNTIME/);
  assert.equal(dispatchRefusal({ subagent_type: "architecture:sdd-implementer", prompt: "p" }, unknown), null);
  const listed = dispatchSettings({ dispatch: { models: { "architecture:sdd-implementer": ["sonnet"] } } }, null);
  assert.equal(dispatchRefusal({ subagent_type: "architecture:sdd-implementer", model: "sonnet", prompt: "p" }, listed), null);
});
