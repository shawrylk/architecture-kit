import test from "node:test";
import assert from "node:assert/strict";
import { checkFeatureSwitches } from "./feature-switches.mjs";

const options = { file: "feature-switches.ts", patterns: ["UNWIRED", "^SHOW_", "_WIRED$"] };

for (const [name, contents] of [
  ["SHOW_DELETE", "const SHOW_DELETE = false;"],
  ["PIN_UNWIRED", "export const PIN_UNWIRED = true;"],
  ["EXPORT_WIRED", "let EXPORT_WIRED = 1;"],
  ["SHOW_ARCHIVE", "\texport\tvar\tSHOW_ARCHIVE = false;"],
]) {
  test(`${name} belongs in the switch file`, () => {
    const problems = checkFeatureSwitches([{ path: "src/features/pins/view.tsx", contents }], options);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].path, "src/features/pins/view.tsx");
    assert.equal(problems[0].rule, "unwire-constant-outside-switch-file");
    assert.ok(problems[0].detail.includes(name));
    assert.ok(problems[0].detail.includes(options.file));
    assert.deepEqual(checkFeatureSwitches([{ path: "src/features/pins/feature-switches.ts", contents }], options), []);
  });
}

test("comments, string values, and names outside the patterns pass", () => {
  const contents = [
    "// const SHOW_X = 1;",
    'const label = "SHOW_X";',
    "const showDelete = false;",
    "const SHOWN_ITEMS = [];",
  ].join("\n");
  assert.deepEqual(checkFeatureSwitches([{ path: "src/features/pins/view.tsx", contents }], options), []);
});

test("every matching declaration gives one problem", () => {
  const contents = "const SHOW_DELETE = false;\nexport const PIN_UNWIRED = true;\nlet EXPORT_WIRED = 1;";
  assert.equal(checkFeatureSwitches([{ path: "pins/view.tsx", contents }], options).length, 3);
});

test("the configured filename and patterns apply", () => {
  const custom = { file: "switches.ts", patterns: ["^DISABLED_"] };
  assert.equal(checkFeatureSwitches([{ path: "pins/feature-switches.ts", contents: "const DISABLED_DELETE = true;" }], custom).length, 1);
  assert.deepEqual(checkFeatureSwitches([{ path: "pins/switches.ts", contents: "const DISABLED_DELETE = true;" }], custom), []);
  assert.deepEqual(checkFeatureSwitches([{ path: "pins/view.tsx", contents: "const SHOW_DELETE = false;" }], custom), []);
});
