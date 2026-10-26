import assert from "node:assert/strict";
import test from "node:test";
import { budgetsOf, compactClaude, compactCodex } from "./setup-compaction.mjs";

test("absent budgets leave both compaction limits unset", () => {
  for (const text of [null, "{}"]) {
    assert.deepEqual(budgetsOf(text), { orchestrator: null, codex: null });
  }
  assert.deepEqual(budgetsOf('{"budgets":{"codex":{"compactAt":300000}}}'), {
    orchestrator: null, codex: 300000,
  });
});

test("reads the orchestrator and Codex compaction budgets", () => {
  assert.deepEqual(budgetsOf('{"budgets":{"orchestrator":{"compactAt":200000},"codex":{"compactAt":300000}}}'), {
    orchestrator: 200000, codex: 300000,
  });
});

test("invalid compaction budgets name the key and the required number", () => {
  for (const agent of ["orchestrator", "codex"]) {
    for (const compactAt of [0, 1.5, "x", -1]) {
      const text = JSON.stringify({ budgets: { [agent]: { compactAt } } });
      assert.throws(() => budgetsOf(text), (error) => {
        assert.ok(error.message.includes(`budgets.${agent}.compactAt`));
        assert.match(error.message, /positive whole number/);
        return true;
      });
    }
  }
});

test("invalid budget JSON names qc.config.json", () => {
  assert.throws(() => budgetsOf("not JSON"), /qc\.config\.json/);
});

test("enables Claude compaction in empty settings without a budget", () => {
  for (const text of ["", "{}"]) {
    assert.deepEqual(compactClaude(text, { models: [], window: null }), {
      text: '{\n  "autoCompactEnabled": true\n}\n',
      changed: ["autoCompactEnabled"],
    });
  }
});

test("preserves Claude settings text when compaction is already enabled", () => {
  const text = ' { "autoCompactEnabled": true, "theme": "dark" }\r\n';
  assert.deepEqual(compactClaude(text, { models: ["claude-opus-5-5"], window: null }), {
    text, changed: [],
  });
});

test("sets Claude model windows while preserving other settings", () => {
  const settings = {
    autoCompactEnabled: true,
    modelSettings: { "claude-opus-5-5": { effortLevel: "high" } },
    theme: "dark",
  };
  const options = { models: ["claude-opus-5-5"], window: 200000 };
  const result = compactClaude(JSON.stringify(settings), options);
  const expected = {
    ...settings,
    modelSettings: { "claude-opus-5-5": { effortLevel: "high", autoCompactWindow: 200000 } },
  };
  assert.deepEqual(JSON.parse(result.text), expected);
  assert.equal(result.text, JSON.stringify(expected, null, 2) + "\n");
  assert.deepEqual(result.changed, ["modelSettings.claude-opus-5-5.autoCompactWindow"]);
  assert.deepEqual(compactClaude(result.text, options), { text: result.text, changed: [] });
});

test("creates Claude model settings and enables disabled compaction", () => {
  const options = { models: ["claude-opus-5-5", "claude-sonnet-4-6"], window: 200000 };
  const result = compactClaude('{"autoCompactEnabled":false}', options);
  assert.deepEqual(JSON.parse(result.text), {
    autoCompactEnabled: true,
    modelSettings: {
      "claude-opus-5-5": { autoCompactWindow: 200000 },
      "claude-sonnet-4-6": { autoCompactWindow: 200000 },
    },
  });
  assert.deepEqual(result.changed, [
    "autoCompactEnabled",
    "modelSettings.claude-opus-5-5.autoCompactWindow",
    "modelSettings.claude-sonnet-4-6.autoCompactWindow",
  ]);
});

test("rejects Claude settings that are not a JSON object", () => {
  for (const text of ["[]", "not JSON", "null", "true", '"settings"', "1"]) {
    assert.throws(() => compactClaude(text, { models: [], window: null }), /JSON settings object/);
  }
});

test("a missing Codex budget preserves the input", () => {
  const text = 'model = "x"\n# keep\n';
  assert.deepEqual(compactCodex(text, null), { text, changed: [] });
});

test("adds the Codex limit while preserving the model and comments", () => {
  const text = 'model = "x"\n# keep\n';
  const result = compactCodex(text, 300000);
  assert.ok(result.text.includes("model_auto_compact_token_limit = 300000\n"));
  assert.ok(result.text.includes('model = "x"\n'));
  assert.ok(result.text.includes("# keep\n"));
  assert.deepEqual(result.changed, ["model_auto_compact_token_limit"]);
  assert.deepEqual(compactCodex(result.text, 300000), { text: result.text, changed: [] });
});

test("replaces the Codex limit while preserving its comment and other tables", () => {
  const text = 'model_auto_compact_token_limit = 100000 # keep\n[profile]\nmodel = "x"\n';
  const result = compactCodex(text, 300000);
  assert.equal(result.text, text.replace("100000", "300000"));
  assert.deepEqual(result.changed, ["model_auto_compact_token_limit"]);
  assert.deepEqual(compactCodex(result.text, 300000), { text: result.text, changed: [] });
});
