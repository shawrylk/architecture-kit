import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const WORKFLOW = fileURLToPath(new URL("../../templates/github/workflows/ci.yml", import.meta.url));
const runs = () => parse(readFileSync(WORKFLOW, "utf8")).jobs.gates.steps.map((step) => step.run ?? "").join("\n");

test("the template runs on pull requests and trunk pushes, and cancels stale pull request runs", () => {
  const workflow = parse(readFileSync(WORKFLOW, "utf8"));
  assert.ok(Object.hasOwn(workflow.on, "pull_request"));
  assert.deepEqual(workflow.on.push.branches, ["main", "master"]);
  assert.ok(workflow.concurrency.group.includes("github.event.pull_request.number"));
  assert.equal(workflow.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
});

test("the template installs with the package manager of the lockfile, so no one tool is assumed", () => {
  const text = runs();
  assert.match(text, /pnpm-lock\.yaml.*pnpm install --frozen-lockfile/);
  assert.match(text, /yarn\.lock.*yarn install --immutable/);
  assert.match(text, /package-lock\.json.*npm ci/);
});

test("the template runs the three checks the hooks run, and lints only the lines a change adds", () => {
  const workflow = parse(readFileSync(WORKFLOW, "utf8"));
  const text = runs();
  for (const command of ["npx qc check", "npx qc typecheck", 'npx qc lint --base "$BASE"']) assert.ok(text.includes(command), command);
  const lint = workflow.jobs.gates.steps.find((step) => /qc lint/.test(step.run ?? ""));
  assert.match(lint.env.BASE, /github\.base_ref/);
  assert.doesNotMatch(text, /eslint \. --max-warnings 0/);
});

test("the policy checks of a pull request are opt-in, not steps of the template", () => {
  const text = runs();
  assert.doesNotMatch(text, /qc pr-check|qc prose/);
  assert.doesNotMatch(readFileSync(WORKFLOW, "utf8"), /^\s*# - run:/m);
});
