import { strict as assert } from "node:assert";
import { test } from "node:test";
import { baselineOf, catalogEntries, renderCatalog, sameCatalog } from "./catalog.mjs";
import { loadTypeScript } from "./typescript.mjs";

const ts = loadTypeScript();
const options = {
  componentRoots: ["frontend/src/platform/ui", "frontend/src/features/*/components"],
  layers: { primitive: "frontend/src/platform/ui/primitives", pattern: "frontend/src/platform/ui/patterns" },
};

const files = [
  { path: "frontend/src/platform/ui/primitives/button.tsx", contents: "/** A pressable control. */\nexport function Button({ label }: { label: string }) { return null; }\n" },
  { path: "frontend/src/platform/ui/patterns/empty-state.tsx", contents: "/** Says a list is empty | and why. */\nexport const EmptyState = () => null;\n" },
  { path: "frontend/src/features/photos/components/grid.tsx", contents: "export const Grid = () => null;\n" },
  { path: "frontend/src/features/photos/components/grid.test.tsx", contents: "export const NotListed = () => null;\n" },
  { path: "frontend/src/features/photos/components/grid.stories.tsx", contents: "export const AlsoNot = () => null;\n" },
  { path: "frontend/src/features/photos/api.tsx", contents: "export const OutsideRoots = () => null;\n" },
  { path: "frontend/src/platform/ui/shell.tsx", contents: "/** The app frame. */\nexport function Shell() { return null; }\n" },
];

test("only exported components under the roots are listed, tests and stories skipped, each with its layer", () => {
  const entries = catalogEntries(ts, options, files);
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.layer]),
    [["Button", "primitive"], ["EmptyState", "pattern"], ["Grid", "feature:photos"], ["Shell", "platform"]],
  );
});

test("the catalog is one table per layer, sorted by name, inside a generated region", () => {
  const text = renderCatalog(catalogEntries(ts, options, files), { layers: options.layers, command: "pnpm codegen" });
  assert.match(text, /^<!-- generated: ui-catalog\. .*pnpm codegen.* -->/);
  assert.ok(text.trimEnd().endsWith("<!-- /generated -->"));
  const order = [...text.matchAll(/^## (.+)$/gm)].map((found) => found[1]);
  assert.deepEqual(order, ["primitive", "pattern", "platform", "feature:photos"]);
  assert.match(text, /\| `Button` \| `frontend\/src\/platform\/ui\/primitives\/button\.tsx` \| `label` \| A pressable control\. \|/);
  assert.match(text, /Says a list is empty \\\| and why\./);
});

test("no component means no catalog text", () => {
  assert.equal(renderCatalog([], { layers: {}, command: "pnpm codegen" }), null);
});

test("sameCatalog ignores line endings and a missing file differs", () => {
  assert.equal(sameCatalog("a\r\nb\n", "a\nb\n"), true);
  assert.equal(sameCatalog("a\n", "b\n"), false);
  assert.equal(sameCatalog(null, "b\n"), false);
  assert.equal(sameCatalog(null, null), true);
});

test("the baseline lists each undocumented component as a sorted path and name", () => {
  const entries = catalogEntries(ts, options, files);
  assert.deepEqual(baselineOf(entries), { undocumented: ["frontend/src/features/photos/components/grid.tsx#Grid"] });
});
