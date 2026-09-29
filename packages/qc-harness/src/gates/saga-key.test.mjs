import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaults, load } from "../config.mjs";
import { runCheck } from "../cli/check.mjs";
import { checkSagaKey } from "./saga-key.mjs";

const RUNNERS = ["runPipeline"];
const file = (contents, name = "frontend/src/features/boards/trigger.ts") => [{ path: name, contents }];
const check = (contents, options = {}) => checkSagaKey(file(contents), { runners: RUNNERS, ...options });

test("runPipeline with mutationId crypto.randomUUID() fails as minted-saga-key", () => {
  const problems = check("await runPipeline({ boardId, mutationId: crypto.randomUUID() });");
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "minted-saga-key");
  assert.match(problems[0].detail, /runPipeline/);
  assert.match(problems[0].detail, /mutationId/);
});

test("each volatile name fails, whatever the qualifier", () => {
  for (const call of ["randomUUID()", "crypto.randomUUID()", "nanoid()", "nanoid(12)", "uuid.v4()", "uuidv4()", "Date.now()"]) {
    assert.equal(check(`runPipeline({ mutationId: ${call} });`).length, 1, call);
  }
});

test("a const minted by randomUUID and passed as mutationId fails", () => {
  const source = ["function retry() {", "  const id = randomUUID();", "  return runPipeline({ mutationId: id });", "}"].join("\n");
  const problems = check(source);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "minted-saga-key");
});

test("a const declared without a semicolon fails", () => {
  const source = ["function retry() {", "  const id = crypto.randomUUID()", "  return runPipeline({ mutationId: id })", "}"].join("\n");
  assert.equal(check(source).length, 1);
});

test("mutationId from state.clientMutationId passes", () => {
  assert.deepEqual(check("runPipeline({ boardId, mutationId: state.clientMutationId });"), []);
  assert.deepEqual(check("const id = state.clientMutationId;\nrunPipeline({ mutationId: id });"), []);
});

test("shorthand mutationId from a minted const fails", () => {
  const source = ["function retry() {", "  const mutationId = nanoid();", "  return runPipeline({ boardId, mutationId });", "}"].join("\n");
  assert.equal(check(source).length, 1);
});

test("shorthand mutationId from a stored const passes", () => {
  assert.deepEqual(check("const mutationId = state.clientMutationId;\nrunPipeline({ mutationId });"), []);
});

test("a call of a function not in runners is ignored", () => {
  assert.deepEqual(check("submitBoard({ mutationId: crypto.randomUUID() });"), []);
  assert.deepEqual(check("obj.runPipeline({ mutationId: crypto.randomUUID() });"), []);
});

test("the finding names file and line", () => {
  const source = ["import { runPipeline } from './pipeline';", "", "export function go() {", "  return runPipeline({ mutationId: randomUUID() });", "}"].join("\n");
  const [problem] = check(source);
  assert.equal(problem.path, "frontend/src/features/boards/trigger.ts");
  assert.match(problem.detail, /line 4\b/);
});

test("a mint of a different property of the call is not the saga key", () => {
  assert.deepEqual(check("runPipeline({ mutationId: state.id, traceId: randomUUID() });"), []);
});

test("the key property, the runners and the volatile names come from options", () => {
  assert.equal(check("runFlow({ requestId: uuid.v4() });", { runners: ["runFlow"], key: "requestId" }).length, 1);
  assert.deepEqual(check("runFlow({ mutationId: uuid.v4() });", { runners: ["runFlow"], key: "requestId" }), []);
  assert.deepEqual(check("runPipeline({ mutationId: randomUUID() });", { volatile: ["nanoid"] }), []);
});

test("a quoted key and a member runner are read", () => {
  assert.equal(check('runPipeline({ "mutationId": randomUUID() });').length, 1);
  assert.equal(check("sagas.runPipeline({ mutationId: randomUUID() });", { runners: ["sagas.runPipeline"] }).length, 1);
});

test("a call spread over lines, with a nested object, is read", () => {
  const source = ["runPipeline(", "  ctx,", "  {", "    payload: { a: 1, b: [2, 3] },", "    mutationId: crypto.randomUUID(),", "  },", ");"].join("\n");
  assert.equal(check(source).length, 1);
});

test("a commented call is not a finding", () => {
  assert.deepEqual(check("// runPipeline({ mutationId: randomUUID() });"), []);
  assert.deepEqual(check("/*\n * runPipeline({ mutationId: randomUUID() });\n */"), []);
});

test("every call of the file is judged", () => {
  const source = "runPipeline({ mutationId: a });\nrunPipeline({ mutationId: randomUUID() });\nrunPipeline({ mutationId: nanoid() });";
  assert.deepEqual(check(source).map((problem) => problem.detail.match(/line (\d+)/)[1]), ["2", "3"]);
});

test("a gate with no runner, or a blank one, fails loudly rather than matching nothing", () => {
  assert.throws(() => check("x", { runners: [] }), /sagaKey\.runners/);
  assert.throws(() => check("x", { runners: [""] }), /sagaKey\.runners/);
  assert.throws(() => check("x", { key: "" }), /sagaKey.key/);
});

// The runner reads the feature files from disk and skips the tests.
async function checked({ sources, gates = { "saga-key": true }, overrides = {} }) {
  const dir = mkdtempSync(path.join(tmpdir(), "qc-saga-key-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const base = load(dir);
    for (const [name, text] of Object.entries(sources)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), text);
    }
    const config = { ...base, ...overrides, gates: { ...base.gates, ...gates } };
    const { problems, lines } = await runCheck(config);
    return { problems: problems.filter((problem) => problem.rule === "minted-saga-key"), lines };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the gate ships off, with a saga key of mutationId and no runner", () => {
  assert.equal(defaults.gates["saga-key"], false);
  assert.deepEqual(defaults.sagaKey, { runners: [], key: "mutationId" });
});

test("qc check reads the feature files, skips the tests, and names a relative path", async () => {
  const feature = "frontend/src/features/boards";
  const sources = {
    [`${feature}/trigger.ts`]: "export const go = () => runPipeline({ mutationId: crypto.randomUUID() });\n",
    [`${feature}/trigger.test.ts`]: "runPipeline({ mutationId: crypto.randomUUID() });\n",
  };
  const overrides = { sagaKey: { runners: ["runPipeline"], key: "mutationId" } };
  const result = await checked({ sources, overrides });
  assert.deepEqual(result.problems.map((problem) => problem.path), [`${feature}/trigger.ts`]);
  assert.ok(result.lines.some((line) => line.includes("saga-key")));
  assert.deepEqual((await checked({ sources, overrides, gates: {} })).problems, []);
});
