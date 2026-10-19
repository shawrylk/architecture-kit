import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const WORKFLOW = fileURLToPath(new URL("../../templates/github/workflows/ci.yml", import.meta.url));

test("the template runs unit tests in eight shards and integration tests in two, all on hosted runners", () => {
  const workflow = parse(readFileSync(WORKFLOW, "utf8"));
  assert.deepEqual(workflow.jobs.unit.strategy.matrix.shard, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(workflow.jobs.integration.strategy.matrix.shard, [1, 2]);
  assert.equal(workflow.jobs.unit.strategy["fail-fast"], false);
  for (const [name, job] of Object.entries(workflow.jobs)) assert.equal(job["runs-on"], "ubuntu-latest", name);
});

test("the template runs the affected browser tests on a pull request and every one on a push", () => {
  const steps = JSON.stringify(parse(readFileSync(WORKFLOW, "utf8")).jobs.e2e.steps);
  assert.match(steps, /pnpm e2e:affected/);
  assert.match(steps, /pnpm e2e"/);
});

test("the e2e job installs the browsers before it runs a spec", () => {
  const steps = parse(readFileSync(WORKFLOW, "utf8")).jobs.e2e.steps;
  const install = steps.findIndex((step) => /playwright install --with-deps/.test(step.run ?? ""));
  const run = steps.findIndex((step) => /pnpm e2e/.test(step.run ?? ""));
  assert.ok(install >= 0 && install < run);
});

test("the gates job typechecks and lints on every push, with no step left commented out", () => {
  const text = readFileSync(WORKFLOW, "utf8");
  const runs = parse(text).jobs.gates.steps.map((step) => step.run ?? "").join("\n");
  assert.match(runs, /pnpm run typecheck/);
  assert.match(runs, /tsc -b/);
  assert.match(runs, /pnpm run lint/);
  assert.match(runs, /eslint \. --max-warnings 0/);
  assert.doesNotMatch(text, /^\s*# - run:/m);
});
