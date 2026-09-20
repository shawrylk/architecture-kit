import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkFeatureAnatomy, checkNoEmptyBlock } from "./eight-blocks.mjs";

test("a complete feature passes", () => {
  const problems = checkFeatureAnatomy([
    { feature: "pins", files: ["index.ts", "trigger.ts", "pipeline.ts", "resource.ts"] },
  ]);
  assert.deepEqual(problems, []);
});

test("a missing required block fails and names it", () => {
  const problems = checkFeatureAnatomy([
    { feature: "pins", files: ["index.ts", "trigger.ts", "pipeline.ts"] },
  ]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "missing-block");
  assert.equal(problems[0].detail, "resource");
});

test("a file that is not one of the eight blocks fails", () => {
  const problems = checkFeatureAnatomy([
    {
      feature: "pins",
      files: ["index.ts", "trigger.ts", "pipeline.ts", "resource.ts", "helpers.ts"],
    },
  ]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "unknown-block");
  assert.equal(problems[0].detail, "helpers.ts");
});

test("a subfolder fails — one block is one file", () => {
  const problems = checkFeatureAnatomy([
    {
      feature: "pins",
      files: ["index.ts", "trigger.ts", "pipeline.ts", "resource.ts", "lib/util.ts"],
    },
  ]);
  assert.ok(problems.some((p) => p.rule === "no-subfolder"));
});

test("test files are not blocks and do not fail the anatomy", () => {
  const problems = checkFeatureAnatomy([
    {
      feature: "pins",
      files: ["index.ts", "trigger.ts", "pipeline.ts", "resource.ts", "pipeline.test.ts"],
    },
  ]);
  assert.deepEqual(problems, []);
});

test("optional blocks are allowed but never required", () => {
  const problems = checkFeatureAnatomy([
    {
      feature: "photos",
      files: ["index.ts", "trigger.ts", "pipeline.ts", "resource.ts", "ledger.ts", "record.ts"],
    },
  ]);
  assert.deepEqual(problems, []);
});

test("a block whose file holds only comments is an empty block", () => {
  const problems = checkNoEmptyBlock([
    { path: "features/pins/ledger.ts", contents: "// TODO\n\n" },
  ]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "empty-block");
});

test("a block with real code is not empty", () => {
  const problems = checkNoEmptyBlock([
    { path: "features/pins/ledger.ts", contents: "// docs/architecture.md\nexport const ledger = {};\n" },
  ]);
  assert.deepEqual(problems, []);
});

test("a valid bounded vertical slice feature passes", () => {
  const problems = checkFeatureAnatomy([
    {
      feature: "pins",
      files: [
        "index.ts",
        "schema.ts",
        "trigger.ts",
        "slices/create-pin.ts",
        "slices/move-pin.ts",
        "shared/queries.ts",
      ],
    },
  ]);
  assert.deepEqual(problems, []);
});

test("a slice feature with a disallowed subfolder fails", () => {
  const problems = checkFeatureAnatomy([
    {
      feature: "pins",
      files: [
        "index.ts",
        "schema.ts",
        "trigger.ts",
        "slices/create-pin.ts",
        "helpers/utils.ts",
      ],
    },
  ]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "disallowed-subfolder");
  assert.equal(problems[0].detail, "helpers/utils.ts");
});

test("a slice feature with nested sub-subfolder fails", () => {
  const problems = checkFeatureAnatomy([
    {
      feature: "pins",
      files: [
        "index.ts",
        "schema.ts",
        "trigger.ts",
        "slices/pin/create.ts",
      ],
    },
  ]);
  assert.ok(problems.some((p) => p.rule === "disallowed-subfolder" && p.detail === "slices/pin/create.ts"));
});

test("a slice feature missing schema fails", () => {
  const problems = checkFeatureAnatomy([
    {
      feature: "pins",
      files: [
        "index.ts",
        "trigger.ts",
        "slices/create-pin.ts",
      ],
    },
  ]);
  assert.ok(problems.some((p) => p.rule === "missing-block" && p.detail === "schema"));
});

test("an empty slice file is caught by checkNoEmptyBlock", () => {
  const problems = checkNoEmptyBlock([
    { path: "features/pins/slices/create-pin.ts", contents: "// empty slice\n\n" },
  ]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "empty-block");
});

test("a slice feature with nested test file fails", () => {
  const problems = checkFeatureAnatomy([
    {
      feature: "pins",
      files: [
        "index.ts",
        "schema.ts",
        "trigger.ts",
        "slices/create-pin.ts",
        "slices/pin/create.test.ts",
      ],
    },
  ]);
  assert.ok(problems.some((p) => p.rule === "disallowed-subfolder" && p.detail === "slices/pin/create.test.ts"));
});

test("a slice feature with index in subfolder fails", () => {
  const problems = checkFeatureAnatomy([
    {
      feature: "pins",
      files: [
        "index.ts",
        "schema.ts",
        "trigger.ts",
        "slices/create-pin.ts",
        "shared/index.ts",
      ],
    },
  ]);
  assert.ok(problems.some((p) => p.rule === "no-subfolder-index" && p.detail === "shared/index.ts"));
});

test("a slice feature with disallowed shared file fails", () => {
  const problems = checkFeatureAnatomy([
    {
      feature: "pins",
      files: [
        "index.ts",
        "schema.ts",
        "trigger.ts",
        "slices/create-pin.ts",
        "shared/utils.ts",
      ],
    },
  ]);
  assert.ok(problems.some((p) => p.rule === "disallowed-shared-file" && p.detail === "shared/utils.ts"));
});

test("a slice feature with co-located test and allowed shared files passes", () => {
  const problems = checkFeatureAnatomy([
    {
      feature: "pins",
      files: [
        "index.ts",
        "schema.ts",
        "trigger.ts",
        "slices/create-pin.ts",
        "slices/create-pin.test.ts",
        "shared/types.ts",
        "shared/queries.ts",
        "shared/guards.ts",
        "shared/guards.test.ts",
        "shared/runner.ts",
      ],
    },
  ]);
  assert.deepEqual(problems, []);
});

test("a backend feature with flat anatomy fails review", () => {
  const problems = checkFeatureAnatomy([
    {
      feature: "backend/src/features/sample",
      files: ["index.ts", "trigger.ts", "pipeline.ts", "resource.ts"],
    },
  ]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "disallowed-flat-anatomy");
});


test("the slice taxonomy comes from options", () => {
  const features = [
    {
      feature: "src/modules/pins",
      files: ["index.ts", "model.ts", "ops/create.ts", "common/lookups.ts"],
    },
  ];
  const anatomy = {
    slice: {
      required: ["index.ts", "model.ts"],
      sliceDir: "ops",
      sharedDir: "common",
      sharedFiles: ["lookups.ts"],
    },
    sliceOnlyRoots: [],
  };
  assert.deepEqual(checkFeatureAnatomy(features, anatomy), []);
});

test("a file outside the configured shared taxonomy fails", () => {
  const features = [
    { feature: "src/modules/pins", files: ["index.ts", "model.ts", "ops/create.ts", "common/misc.ts"] },
  ];
  const anatomy = {
    slice: { required: ["index.ts", "model.ts"], sliceDir: "ops", sharedDir: "common", sharedFiles: ["lookups.ts"] },
    sliceOnlyRoots: [],
  };
  const problems = checkFeatureAnatomy(features, anatomy);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "disallowed-shared-file");
});

test("a repository naming no slice-only root may keep the flat anatomy anywhere", () => {
  const features = [
    { feature: "backend/src/features/pins", files: ["index.ts", "trigger.ts", "pipeline.ts", "resource.ts"] },
  ];
  assert.deepEqual(checkFeatureAnatomy(features, { sliceOnlyRoots: [] }), []);
});

test("a slice feature with components directory with index passes", () => {
  const features = [
    {
      feature: "photos",
      files: [
        "index.ts",
        "schema.ts",
        "trigger.ts",
        "slices/view-photo.ts",
        "components/photo-viewer/index.ts",
        "components/photo-viewer/toolbar.tsx",
      ],
    },
  ];
  assert.deepEqual(checkFeatureAnatomy(features), []);
});

test("a slice feature with component view missing index fails", () => {
  const features = [
    {
      feature: "photos",
      files: [
        "index.ts",
        "schema.ts",
        "trigger.ts",
        "slices/view-photo.ts",
        "components/photo-viewer/toolbar.tsx",
      ],
    },
  ];
  const problems = checkFeatureAnatomy(features);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "missing-component-index");
});

test("a slice feature with loose component outside a view folder fails", () => {
  const features = [
    {
      feature: "photos",
      files: [
        "index.ts",
        "schema.ts",
        "trigger.ts",
        "slices/view-photo.ts",
        "components/loose-button.tsx",
      ],
    },
  ];
  const problems = checkFeatureAnatomy(features);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "loose-component");
});

test("a slice feature with ui fragments in slices fails", () => {
  const features = [
    {
      feature: "blackboard",
      files: [
        "index.ts",
        "schema.ts",
        "trigger.ts",
        "slices/list-boards.ts",
        "slices/board-rail.tsx",
      ],
    },
  ];
  const problems = checkFeatureAnatomy(features);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "ui-fragment-in-slices");
});

test("a slice feature with deeply nested components (> depth 3) fails", () => {
  const features = [
    {
      feature: "photos",
      files: [
        "index.ts",
        "schema.ts",
        "trigger.ts",
        "slices/view-photo.ts",
        "components/a/b/c.tsx",
      ],
    },
  ];
  const problems = checkFeatureAnatomy(features);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "disallowed-subfolder");
  assert.equal(problems[0].detail, "components/a/b/c.tsx");
});

