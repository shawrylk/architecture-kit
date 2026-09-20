import test from "node:test";
import assert from "node:assert/strict";
import { checkFeatureCommands, governedFeatures } from "./feature-cli.mjs";

const FEATURE = "backend/src/features/progress";

function tree({ cli, index, test: testFile } = {}) {
  const files = [];
  if (cli !== undefined) files.push({ path: `${FEATURE}/cli.ts`, contents: cli });
  if (index !== undefined) files.push({ path: `${FEATURE}/index.ts`, contents: index });
  if (testFile !== undefined) files.push({ path: `${FEATURE}/cli.test.ts`, contents: testFile });
  return files;
}

const GOOD_CLI = 'import { defineCommands } from "@qc/kernel";\nexport const commands = defineCommands("progress", {});';
const SAGA = 'export const createEntry = definePipeline({});';
const GOOD_INDEX = 'export { commands } from "./cli.js";';
const GOOD_TEST = 'import { commands } from "./cli.js";';

function features(files) {
  return [{ feature: FEATURE, files: files.map((file) => file.path.slice(FEATURE.length + 1)) }];
}

test("a feature with a declared, published, tested command block passes", () => {
  const files = tree({ cli: GOOD_CLI, index: GOOD_INDEX, test: GOOD_TEST });
  assert.deepEqual(checkFeatureCommands(features(files), files, { tests: [files[2]] }), []);
});

test("a feature carrying no cli block fails and names feature-cli-missing", () => {
  const files = tree({ index: GOOD_INDEX });
  const problems = checkFeatureCommands(features(files), files);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "feature-cli-missing");
  assert.equal(problems[0].feature, FEATURE);
});

test("a cli block importing react fails and names feature-cli-no-view", () => {
  const files = tree({ cli: `import * as React from "react";\n${GOOD_CLI}`, index: GOOD_INDEX });
  const problems = checkFeatureCommands(features(files), files);
  assert.deepEqual(problems.map((problem) => problem.rule), ["feature-cli-no-view"]);
});

test("a cli block importing a server framework fails and names feature-cli-no-server", () => {
  const files = tree({ cli: `import Fastify from "fastify";\n${GOOD_CLI}`, index: GOOD_INDEX });
  const problems = checkFeatureCommands(features(files), files);
  assert.deepEqual(problems.map((problem) => problem.rule), ["feature-cli-no-server"]);
});

test("a cli block declaring no command through the factory fails", () => {
  const files = tree({ cli: "export const commands = {};", index: GOOD_INDEX });
  const problems = checkFeatureCommands(features(files), files);
  assert.deepEqual(problems.map((problem) => problem.rule), ["feature-cli-undeclared"]);
});

test("a cli block the index does not re-export fails and names feature-cli-unpublished", () => {
  const files = tree({ cli: GOOD_CLI, index: 'export { trigger } from "./trigger.js";' });
  const problems = checkFeatureCommands(features(files), files);
  assert.deepEqual(problems.map((problem) => problem.rule), ["feature-cli-unpublished"]);
});

test("a feature with no index at all fails as unpublished rather than throwing", () => {
  const files = tree({ cli: GOOD_CLI });
  const problems = checkFeatureCommands(features(files), files);
  assert.deepEqual(problems.map((problem) => problem.rule), ["feature-cli-unpublished"]);
});

test("a command block no test imports fails and names feature-cli-untested", () => {
  const files = tree({ cli: GOOD_CLI, index: GOOD_INDEX });
  const elsewhere = { path: "backend/src/features/photos/cli.test.ts", contents: GOOD_TEST };
  const problems = checkFeatureCommands(features(files), files, { tests: [elsewhere] });
  assert.deepEqual(problems.map((problem) => problem.rule), ["feature-cli-untested"]);
});

test("a feature outside the configured roots is not asked for a command block", () => {
  const files = tree({ index: GOOD_INDEX });
  assert.deepEqual(checkFeatureCommands(features(files), files, { roots: ["frontend/src/features"] }), []);
});

test("the block name, the factory and the publisher come from options", () => {
  const feature = "api/features/pins";
  const files = [
    { path: `${feature}/command.ts`, contents: 'export const run = defineTasks("pins", {});' },
    { path: `${feature}/barrel.ts`, contents: 'export { run } from "./command.js";' },
  ];
  const found = [{ feature, files: ["command.ts", "barrel.ts"] }];
  const options = { block: "command", factory: "defineTasks", publisher: "barrel" };
  assert.deepEqual(checkFeatureCommands(found, files, options), []);
});

test("an empty block name fails loudly rather than matching nothing", () => {
  assert.throws(() => checkFeatureCommands([], [], { block: "" }), /cli\.block/);
});

test("an empty factory list fails loudly rather than matching nothing", () => {
  assert.throws(() => checkFeatureCommands([], [], { factory: [] }), /cli\.factory/);
});

test("a saga the command table does not drive fails and names feature-cli-undrivable-saga", () => {
  const files = [
    { path: `${FEATURE}/cli.ts`, contents: GOOD_CLI },
    { path: `${FEATURE}/index.ts`, contents: GOOD_INDEX },
    { path: `${FEATURE}/slices/create-entry.ts`, contents: SAGA },
  ];
  const found = [{ feature: FEATURE, files: ["cli.ts", "index.ts", "slices/create-entry.ts"] }];
  const problems = checkFeatureCommands(found, files, {});
  assert.deepEqual(problems.map((problem) => problem.rule), ["feature-cli-undrivable-saga"]);
  assert.match(problems[0].detail, /createEntry/);
});

test("a command table driving every declared saga passes", () => {
  const cli = 'export const commands = defineCommands("progress", { "create-entry": { saga: createEntry } });';
  const files = [
    { path: `${FEATURE}/cli.ts`, contents: cli },
    { path: `${FEATURE}/index.ts`, contents: GOOD_INDEX },
    { path: `${FEATURE}/slices/create-entry.ts`, contents: SAGA },
  ];
  const found = [{ feature: FEATURE, files: ["cli.ts", "index.ts", "slices/create-entry.ts"] }];
  assert.deepEqual(checkFeatureCommands(found, files, {}), []);
});

test("a command naming a saga the feature does not declare fails", () => {
  const cli = 'export const commands = defineCommands("progress", { "nope": { saga: notHere } });';
  const files = [
    { path: `${FEATURE}/cli.ts`, contents: cli },
    { path: `${FEATURE}/index.ts`, contents: GOOD_INDEX },
  ];
  const found = [{ feature: FEATURE, files: ["cli.ts", "index.ts"] }];
  const problems = checkFeatureCommands(found, files, {});
  assert.deepEqual(problems.map((problem) => problem.rule), ["feature-cli-unknown-saga"]);
  assert.match(problems[0].detail, /notHere/);
});

test("a saga declared in a sibling feature is not the one this command table owes", () => {
  const cli = 'export const commands = defineCommands("progress", {});';
  const files = [
    { path: `${FEATURE}/cli.ts`, contents: cli },
    { path: `${FEATURE}/index.ts`, contents: GOOD_INDEX },
    { path: "backend/src/features/photos/slices/upload.ts", contents: "export const upload = definePipeline({});" },
  ];
  const found = [{ feature: FEATURE, files: ["cli.ts", "index.ts"] }];
  assert.deepEqual(checkFeatureCommands(found, files, {}), []);
});

test("a saga declared only in a test file is not owed a command", () => {
  const files = [
    { path: `${FEATURE}/cli.ts`, contents: GOOD_CLI },
    { path: `${FEATURE}/index.ts`, contents: GOOD_INDEX },
    { path: `${FEATURE}/pipeline.test.ts`, contents: SAGA },
  ];
  const found = [{ feature: FEATURE, files: ["cli.ts", "index.ts", "pipeline.test.ts"] }];
  assert.deepEqual(checkFeatureCommands(found, files, {}), []);
});

test("the key a command entry names its workflow with comes from options", () => {
  const cli = 'export const commands = defineCommands("progress", { "create-entry": { runs: createEntry } });';
  const files = [
    { path: `${FEATURE}/cli.ts`, contents: cli },
    { path: `${FEATURE}/index.ts`, contents: GOOD_INDEX },
    { path: `${FEATURE}/slices/create-entry.ts`, contents: SAGA },
  ];
  const found = [{ feature: FEATURE, files: ["cli.ts", "index.ts", "slices/create-entry.ts"] }];
  assert.deepEqual(checkFeatureCommands(found, files, { drives: "runs" }), []);
});

test("the governed count is the features the roots cover, not every feature in the tree", () => {
  const found = [
    { feature: "backend/src/features/progress", files: [] },
    { feature: "frontend/src/features/progress", files: [] },
  ];
  assert.equal(governedFeatures(found, { roots: ["backend/src/features"] }), 1);
  assert.equal(governedFeatures(found, {}), 2);
});
