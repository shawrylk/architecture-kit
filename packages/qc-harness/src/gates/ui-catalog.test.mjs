import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkUiCatalog } from "./ui-catalog.mjs";

const documented = { name: "Button", path: "ui/button.tsx", line: 3, description: "A control." };
const bare = { name: "Grid", path: "ui/grid.tsx", line: 7, description: "" };
const fresh = { path: "docs/ui-catalog.md", actual: "same", expected: "same", command: "qc ui catalog" };
const options = (over = {}) => ({ catalog: fresh, baseline: null, baselineFile: "ui-catalog.baseline.json", ...over });

test("documented components and a fresh catalog pass", () => {
  assert.deepEqual(checkUiCatalog([documented], options()), []);
});

test("an exported component with no JSDoc sentence fails, naming path:line", () => {
  const [problem] = checkUiCatalog([documented, bare], options());
  assert.equal(problem.rule, "undocumented-component");
  assert.equal(problem.path, "ui/grid.tsx:7");
  assert.match(problem.detail, /Grid/);
});

test("a stale catalog fails and names the command that writes it", () => {
  const [problem] = checkUiCatalog([documented], options({ catalog: { ...fresh, actual: "old" } }));
  assert.equal(problem.rule, "stale-catalog");
  assert.match(problem.detail, /qc ui catalog/);
});

test("a catalog file that does not exist is stale when components exist", () => {
  const [problem] = checkUiCatalog([documented], options({ catalog: { ...fresh, actual: null } }));
  assert.equal(problem.rule, "stale-catalog");
});

test("a repository with no component and no catalog file passes", () => {
  assert.deepEqual(checkUiCatalog([], options({ catalog: { ...fresh, actual: null, expected: null } })), []);
});

test("a baseline entry excuses its component", () => {
  assert.deepEqual(checkUiCatalog([bare], options({ baseline: ["ui/grid.tsx#Grid"] })), []);
});

test("a baseline entry that no longer fails is an error, so the baseline only shrinks", () => {
  const problems = checkUiCatalog([documented, bare], options({ baseline: ["ui/grid.tsx#Grid", "ui/button.tsx#Button", "ui/gone.tsx#Gone"] }));
  assert.deepEqual(
    problems.map((problem) => [problem.rule, problem.path]),
    [["stale-baseline", "ui-catalog.baseline.json"], ["stale-baseline", "ui-catalog.baseline.json"]],
  );
  assert.match(problems[0].detail, /ui\/button\.tsx#Button/);
  assert.match(problems[1].detail, /ui\/gone\.tsx#Gone/);
});
