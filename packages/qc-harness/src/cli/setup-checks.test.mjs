import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EOL } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkTools, personSteps, runTool } from "./setup-checks.mjs";

const toolNames = ["node", "pnpm", "gh", "codex"];
const installSteps = [
  "Install node 22 or later",
  "Install pnpm 10 (run corepack enable)",
  "Install the GitHub CLI (gh)",
  "Install the Codex CLI",
];
const awsStep = "Set up the AWS SSO profile: run `aws configure sso`";

/** Fragment: supply a finished machine through fake checks. */
function machine(overrides = {}) {
  const home = join("test-home");
  const codexDir = join(home, "custom-codex");
  return {
    home,
    codexDir,
    tools: toolNames.map((tool) => ({ tool, found: true, version: "v22.0.0" })),
    run(tool, args) {
      assert.equal(tool, "gh");
      assert.deepEqual(args, ["auth", "status"]);
      return { status: 0, stdout: "" };
    },
    exists(path) {
      assert.equal(path, join(codexDir, "auth.json"));
      return true;
    },
    readText(path) {
      assert.equal(path, join(home, ".aws", "config"));
      return "[profile work]\nsso_session = x\n";
    },
    ...overrides,
  };
}

test("checks tools in order with --version and trims the first stdout line", () => {
  const calls = [];
  const tools = checkTools((tool, args) => {
    calls.push([tool, args]);
    return { status: 0, stdout: " v22.1.0 \nmore" };
  });
  assert.deepEqual(calls, toolNames.map((tool) => [tool, ["--version"]]));
  assert.deepEqual(tools, toolNames.map((tool) => ({ tool, found: true, version: "v22.1.0" })));
});

for (const status of [null, 1, 127]) {
  test(`treats tool status ${status} as missing despite stdout`, () => {
    assert.deepEqual(
      checkTools(() => ({ status, stdout: "v22.1.0\nmore" })),
      toolNames.map((tool) => ({ tool, found: false, version: null })),
    );
  });
}

test("runs a tool and returns its status and stdout", () => {
  assert.deepEqual(runTool("node", ["--version"]), {
    status: 0,
    stdout: `${process.version}${EOL}`,
  });
});

test("tool checks emit no shell argument deprecation warning", () => {
  const source = `import { runTool } from ${JSON.stringify(new URL("./setup-checks.mjs", import.meta.url).href)}; process.exitCode = runTool("node", ["--version"]).status;`;
  const result = spawnSync(process.execPath, ["--throw-deprecation", "--input-type=module", "-e", source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /DEP0190/);
});

test("normalizes missing stdout when a tool cannot start", () => {
  const result = runTool("qc-nonexistent-setup-tool", ["--version"]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
});

test("a finished machine needs no steps and reads only the AWS config", () => {
  assert.deepEqual(personSteps(machine()), []);
});

for (const [index, tool] of toolNames.entries()) {
  test(`a missing ${tool} needs its install step`, () => {
    const options = machine();
    options.tools[index] = { tool, found: false, version: null };
    if (tool === "gh") options.run = () => assert.fail("a missing gh cannot check authentication");
    if (tool === "codex") options.exists = () => assert.fail("a missing codex cannot check auth.json");
    assert.deepEqual(personSteps(options), [installSteps[index]]);
  });
}

test("lists missing tools in order before the AWS step", () => {
  assert.deepEqual(personSteps(machine({
    tools: toolNames.map((tool) => ({ tool, found: false, version: null })),
    run: () => assert.fail("missing tools cannot run"),
    exists: () => assert.fail("missing codex cannot check auth.json"),
    readText: () => null,
  })), [...installSteps, awsStep]);
});

for (const version of ["v20.19.0", "v21.7.3", "21.7.3"]) {
  test(`node ${version} needs node 22 or later`, () => {
    const options = machine();
    options.tools[0].version = version;
    assert.deepEqual(personSteps(options), [installSteps[0]]);
  });
}

test("node newer than 22 needs no install step", () => {
  const options = machine();
  options.tools[0].version = "v24.0.0";
  assert.deepEqual(personSteps(options), []);
});

for (const status of [null, 1]) {
  test(`gh auth status ${status} needs a login`, () => {
    const options = machine();
    const run = options.run;
    options.run = (tool, args) => ({ ...run(tool, args), status });
    assert.deepEqual(personSteps(options), ["Run `gh auth login`"]);
  });
}

test("a missing Codex auth file needs a login without reading credentials", () => {
  const options = machine();
  const exists = options.exists;
  options.exists = (path) => { exists(path); return false; };
  assert.deepEqual(personSteps(options), ["Run `codex login`"]);
});

for (const text of [null, "", "[profile work]\nregion = us-east-1\n",
  "# sso_session = x\n", "prefix_sso_start_url = x\n"]) {
  test(`AWS config ${JSON.stringify(text)} needs SSO setup`, () => {
    assert.deepEqual(personSteps(machine({ readText: () => text })), [awsStep]);
  });
}

for (const text of ["[profile work]\nsso_session = x\n", "  sso_start_url = https://example.test/start\n"]) {
  test(`AWS config accepts ${JSON.stringify(text)}`, () => {
    assert.deepEqual(personSteps(machine({ readText: () => text })), []);
  });
}

test("lists install steps, GitHub login, Codex login, and AWS setup in order", () => {
  const options = machine({
    run: () => ({ status: 1, stdout: "" }),
    exists: () => false,
    readText: () => null,
  });
  options.tools[0].version = "v20.0.0";
  options.tools[1] = { tool: "pnpm", found: false, version: null };
  assert.deepEqual(personSteps(options), [
    installSteps[0], installSteps[1], "Run `gh auth login`", "Run `codex login`", awsStep,
  ]);
});
