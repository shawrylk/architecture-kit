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
  assert.equal(workflow.concurrency["cancel-in-progress"], "${{ github.event_name != 'merge_group' }}");
});

const KIT_WORKFLOW = fileURLToPath(new URL("../../../../.github/workflows/ci.yml", import.meta.url));

for (const [name, file] of [["template", WORKFLOW], ["kit", KIT_WORKFLOW]]) {
  test(`${name} skips drafts and starts CI when a draft becomes ready`, () => {
    const workflow = parse(readFileSync(file, "utf8"));
    assert.deepEqual(workflow.on.push.branches, name === "template" ? ["main", "master"] : ["main"]);
    assert.deepEqual(workflow.on.pull_request.types, ["opened", "synchronize", "reopened", "ready_for_review"]);
    assert.equal(workflow.jobs.gates.if, "${{ github.event_name != 'pull_request' || github.event.pull_request.draft == false }}");
    assert.ok(workflow.concurrency.group.includes("github.event.pull_request.number"));
    assert.ok(workflow.concurrency.group.includes("github.event_name"));
    assert.equal(workflow.concurrency["cancel-in-progress"], "${{ github.event_name != 'merge_group' }}");
    assert.ok(Object.hasOwn(workflow.on, "merge_group"));
  });

  test(`${name} dispatch chooses Linux, Windows, or both matrix legs`, () => {
    const workflow = parse(readFileSync(file, "utf8"));
    const input = workflow.on.workflow_dispatch.inputs.os;
    assert.equal(input.type, "choice");
    assert.equal(input.required, true);
    assert.equal(input.default, "both");
    assert.deepEqual(input.options, ["linux", "windows", "both"]);
    assert.equal(workflow.jobs.gates["runs-on"], "${{ matrix.os }}");
    assert.equal(workflow.jobs.gates.defaults.run.shell, "bash");
    const matrix = workflow.jobs.gates.strategy.matrix.os;
    const expression = matrix.slice(3, -2).trim().replace(/fromJSON/g, "JSON.parse");
    const evaluate = (event, os) => Function("github", "inputs", `return (${expression})`)({ event_name: event }, { os });
    assert.deepEqual(evaluate("workflow_dispatch", "linux"), ["ubuntu-latest"]);
    assert.deepEqual(evaluate("workflow_dispatch", "windows"), ["windows-latest"]);
    assert.deepEqual(evaluate("workflow_dispatch", "both"), ["ubuntu-latest", "windows-latest"]);
    const normal = name === "template" ? ["ubuntu-latest"] : ["ubuntu-latest", "windows-latest"];
    assert.deepEqual(evaluate("pull_request", ""), normal);
    assert.deepEqual(evaluate("push", ""), normal);
    assert.deepEqual(evaluate("merge_group", ""), normal);
  });
}

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
