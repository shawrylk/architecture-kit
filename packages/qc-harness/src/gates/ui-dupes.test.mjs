import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkUiDupes } from "./ui-dupes.mjs";

const card = { kind: "component-name", key: "Card", files: ["ui/a/card.tsx", "ui/b/card.tsx"] };
const classes = { kind: "class-string", key: "a b c", files: ["ui/a.tsx", "ui/b.tsx", "ui/c.tsx"] };
const options = (over = {}) => ({ baseline: null, baselineFile: "ui-dupes.baseline.json", ...over });

test("no finding passes", () => {
  assert.deepEqual(checkUiDupes([], options()), []);
});

test("a finding outside the baseline fails, naming its files", () => {
  const [problem] = checkUiDupes([card], options());
  assert.equal(problem.rule, "duplicate-component-name");
  assert.equal(problem.path, "ui/a/card.tsx");
  assert.match(problem.detail, /ui\/b\/card\.tsx/);
});

test("a finding in the baseline passes", () => {
  assert.deepEqual(checkUiDupes([card, classes], options({ baseline: ["component-name:Card", "class-string:a b c"] })), []);
});

test("a baseline entry that no longer occurs is an error, so the baseline only shrinks", () => {
  const [problem] = checkUiDupes([card], options({ baseline: ["component-name:Card", "class-string:gone"] }));
  assert.equal(problem.rule, "stale-baseline");
  assert.equal(problem.path, "ui-dupes.baseline.json");
  assert.match(problem.detail, /class-string:gone/);
});
