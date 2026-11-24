import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    if (name === "kit") {
      assert.equal(workflow.jobs.gates.needs, "plan");
      assert.equal(workflow.jobs.gates.strategy.matrix.os, "${{ fromJSON(needs.plan.outputs.os) }}");
      const step = workflow.jobs.plan.steps.find((s) => s.id === "matrix");
      const choose = (EVENT, RISKY = "", REQUESTED_OS = "") => {
        const dir = mkdtempSync(join(tmpdir(), "qc-plan-"));
        const out = join(dir, "out");
        writeFileSync(out, "");
        const result = spawnSync("bash", ["-c", step.run], { env: { ...process.env, EVENT, RISKY, REQUESTED_OS, GITHUB_OUTPUT: out }, encoding: "utf8" });
        const text = readFileSync(out, "utf8");
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        return result.status === 0 ? JSON.parse(text.trim().replace(/^os=/, "")) : null;
      };
      const both = ["ubuntu-latest", "windows-latest"];
      assert.deepEqual(choose("pull_request", "false"), ["ubuntu-latest"]);
      assert.deepEqual(choose("pull_request", "true"), both);
      assert.equal(choose("pull_request", ""), null, "a missing scan fails the run");
      assert.deepEqual(choose("push", "false"), ["ubuntu-latest"]);
      assert.deepEqual(choose("push", "true"), both);
      assert.deepEqual(choose("workflow_dispatch", "", "linux"), ["ubuntu-latest"]);
      assert.deepEqual(choose("workflow_dispatch", "", "windows"), ["windows-latest"]);
      assert.deepEqual(choose("workflow_dispatch", "", "both"), both);
      assert.deepEqual(choose("schedule"), both);
      assert.deepEqual(choose("merge_group"), both);
      return;
    }
    const matrix = workflow.jobs.gates.strategy.matrix.os;
    const expression = matrix.slice(3, -2).trim().replace(/fromJSON/g, "JSON.parse");
    const evaluate = (event, os) => Function("github", "inputs", `return (${expression})`)({ event_name: event }, { os });
    assert.deepEqual(evaluate("workflow_dispatch", "linux"), ["ubuntu-latest"]);
    assert.deepEqual(evaluate("workflow_dispatch", "windows"), ["windows-latest"]);
    assert.deepEqual(evaluate("workflow_dispatch", "both"), ["ubuntu-latest", "windows-latest"]);
    const normal = ["ubuntu-latest", "windows-latest"];
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


test("the CI template runs --affected on pull_request and pnpm test on push to main and on schedule", async () => {
  for (const file of [WORKFLOW, KIT_WORKFLOW]) {
    const workflow = parse(readFileSync(file, "utf8"));
    assert.deepEqual(workflow.on.schedule, [{ cron: "0 2 * * *" }]);
    assert.deepEqual(workflow.permissions, { contents: "read" });
    const steps = workflow.jobs.gates.steps;
    if (file === KIT_WORKFLOW) {
      assert.doesNotMatch(readFileSync(file, "utf8"), /\bnpx\s+qc\b/);
    }
    const affected = steps.find((step) => /check --affected --base origin\/main/.test(step.run ?? ""));
    assert.equal(affected.if, "github.event_name == 'pull_request'");
    const full = steps.find((step) => /pnpm test|run test/.test(step.run ?? ""));
    assert.equal(full.if, file === KIT_WORKFLOW
      ? "github.event_name == 'schedule' || github.event_name == 'merge_group' || github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && (github.event.before == '' || github.event.before == '0000000000000000000000000000000000000000'))"
      : "github.event_name != 'pull_request'");
    if (file === KIT_WORKFLOW) {
      const pushed = steps.find((step) => /check --affected --base "\$BEFORE"/.test(step.run ?? ""));
      assert.equal(pushed.if, "github.event_name == 'push' && github.event.before != '' && github.event.before != '0000000000000000000000000000000000000000'");
    }
    const job = workflow.jobs['report-failure'];
    assert.equal(job.needs, 'gates');
    assert.deepEqual(job.concurrency, { group: 'ci-red-${{ github.sha }}', 'cancel-in-progress': false });
    assert.equal(job.if, "${{ always() && needs.gates.result == 'failure' && ((github.event_name == 'push' && github.ref == 'refs/heads/main') || github.event_name == 'schedule') }}");
    assert.equal(job.permissions.issues, 'write');
    assert.equal(workflow.jobs.gates.permissions?.issues, undefined);
    const script = job.steps.find((step) => step.uses?.startsWith('actions/github-script@')).with.script;
    const calls = [], issues = [];
    const github = { rest: { issues: {
      async createLabel(args) { calls.push(args); },
      async listForRepo() { return { data: issues }; },
      async create(args) { calls.push(args); issues.push({ title: args.title }); },
    } }, async paginate(fn, args) { return (await fn(args)).data; } };
    const context = { repo: { owner: 'owner', repo: 'repo' }, sha: 'abc123', serverUrl: 'https://github.com', runId: 42 };
    const run = new (Object.getPrototypeOf(async function() {}).constructor)('github', 'context', script);
    await run(github, context); await run(github, context);
    const created = calls.filter((args) => args.body);
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].labels, ['ci-red', 'priority']);
    assert.match(created[0].body, /abc123/);
    assert.match(created[0].body, /https:\/\/github.com\/owner\/repo\/actions\/runs\/42/);
    github.rest.issues.createLabel = async () => { throw Object.assign(Error('exists'), { status: 422 }); };
    await run(github, context); assert.equal(calls.filter((args) => args.body).length, 1);
    github.rest.issues.createLabel = async () => { throw Object.assign(Error('denied'), { status: 403 }); };
    await assert.rejects(run(github, context), /denied/);
  }
});
