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
// The gate has no list of its own: `qc check` passes `idempotency.volatile`, and this is what that holds.
const VOLATILE = ["Date.now", "Math.random", "crypto.randomUUID", "uuid", "uuidv4", "nanoid", "randomUUID"];
const check = (contents, options = {}) => checkSagaKey(file(contents), { runners: RUNNERS, volatile: VOLATILE, ...options });

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

const rest = "{ pipeline, mutationId, state }";
const lines = (...parts) => parts.join("\n");

test("a const minted before a callback arrow is still the one the call reads", () => {
  const source = lines(
    "async function retry() {",
    "  const mutationId = crypto.randomUUID();",
    "  items.forEach((i) => {",
    "    log(i);",
    "  });",
    `  return runPipeline(${rest});`,
    "}",
  );
  assert.equal(check(source).length, 1);
});

test("a const minted before a nested function is still the one the call reads", () => {
  const source = lines(
    "async function retry() {",
    "  const mutationId = crypto.randomUUID();",
    "  function helper() {",
    "    return 1;",
    "  }",
    `  return runPipeline(${rest});`,
    "}",
  );
  assert.equal(check(source).length, 1);
});

test("a const of a closed sibling block is not in scope of the call", () => {
  const source = lines(
    "function first() {",
    "  const mutationId = crypto.randomUUID();",
    "  return mutationId;",
    "}",
    "function second(state) {",
    "  const mutationId = state.clientMutationId;",
    `  return runPipeline(${rest});`,
    "}",
  );
  assert.deepEqual(check(source), []);
  const bare = lines(
    "function first() {",
    "  const mutationId = crypto.randomUUID();",
    "  return mutationId;",
    "}",
    "function second(mutationId) {",
    `  return runPipeline(${rest});`,
    "}",
  );
  assert.deepEqual(check(bare), []);
});

test("the nearest const shadows an outer minted one", () => {
  const source = lines(
    "const mutationId = randomUUID();",
    "function go(state) {",
    "  const mutationId = state.clientMutationId;",
    `  return runPipeline(${rest});`,
    "}",
  );
  assert.deepEqual(check(source), []);
});

test("a top-level const minted outside the function is read", () => {
  const source = lines("const mutationId = nanoid();", "export function go() {", `  return runPipeline(${rest});`, "}");
  assert.equal(check(source).length, 1);
});

test("a const chained through another const is followed", () => {
  const source = lines("function go() {", "  const first = randomUUID();", "  const second = first;", "  return runPipeline({ mutationId: second });", "}");
  assert.equal(check(source).length, 1);
  const stored = lines("function go(state) {", "  const first = state.id;", "  const second = first;", "  return runPipeline({ mutationId: second });", "}");
  assert.deepEqual(check(stored), []);
  const loop = lines("function go() {", "  const a = b;", "  const b = a;", "  return runPipeline({ mutationId: a });", "}");
  assert.deepEqual(check(loop), []);
});

test("a const initialised over several lines is read whole", () => {
  const source = lines("function go(state) {", "  const id =", "    state.resume", "      ? state.id", "      : randomUUID();", "  return runPipeline({ mutationId: id });", "}");
  assert.equal(check(source).length, 1);
  const next = lines("function go(state) {", "  const id = state.id", "  const other = randomUUID()", "  return runPipeline({ mutationId: id, other });", "}");
  assert.deepEqual(check(next), []);
});

test("each branch of ??, ||, &&, and ?: is judged", () => {
  const minted = [
    "options.mutationId ?? crypto.randomUUID()",
    "crypto.randomUUID() ?? options.mutationId",
    "options.mutationId || randomUUID()",
    "options.ready && randomUUID()",
    "options.resume ? options.mutationId : nanoid()",
    "options.resume ? randomUUID() : options.mutationId",
    "options.a ? options.b : options.c ?? uuid.v4()",
  ];
  for (const value of minted) assert.equal(check(`runPipeline({ mutationId: ${value} });`).length, 1, value);
});

test("the condition of a ternary and the guard of && are not the key", () => {
  assert.deepEqual(check("runPipeline({ mutationId: Date.now() > limit ? state.a : state.b });"), []);
  assert.deepEqual(check("runPipeline({ mutationId: nanoid() && state.id });"), []);
});

test("parentheses, await, a cast and a non-null mark do not hide a mint", () => {
  for (const value of ["(crypto.randomUUID())", "((randomUUID()))", "(options.id ?? randomUUID())", "await mint(randomUUID())", "randomUUID() as string", "randomUUID()!"]) {
    assert.equal(check(`runPipeline({ mutationId: ${value} });`).length, 1, value);
  }
});

test("a mint inside a wrapping call's arguments fails", () => {
  for (const value of ["String(Date.now())", "useRef(randomUUID())", "useMemo(() => randomUUID(), [])", "new Date().toISOString()", "hash(state.id, Math.random())"]) {
    assert.equal(check(`runPipeline({ mutationId: ${value} });`).length, 1, value);
  }
});

test("a wrapping call of stored values passes", () => {
  assert.deepEqual(check("runPipeline({ mutationId: String(state.clientMutationId) });"), []);
  assert.deepEqual(check("runPipeline({ mutationId: options.mutationId ?? state.clientMutationId });"), []);
});

test("the outbox key expression of quality-control-mono fails inside a runner call", () => {
  assert.equal(check("runPipeline({ mutationId: options.mutationId ?? crypto.randomUUID(), failureCode: null });").length, 1);
});

test("a comment or a string that holds a call is not a call", () => {
  assert.deepEqual(check('log("runPipeline({ mutationId: randomUUID() })");'), []);
  assert.deepEqual(check("go(); // runPipeline({ mutationId: randomUUID() })"), []);
  assert.deepEqual(check("runPipeline({ mutationId: /* randomUUID() */ state.id });"), []);
  assert.deepEqual(check("runPipeline({ mutationId: state.id, note: 'randomUUID()' });"), []);
  assert.deepEqual(check("const id = `x ${state.id} randomUUID()`;\nrunPipeline({ mutationId: id });"), []);
  assert.deepEqual(check("runPipeline({ mutationId: state.id }); /* runPipeline({ mutationId: randomUUID() }) */"), []);
});

test("a quote inside a comment starts no string", () => {
  const source = lines("// it's a note", "runPipeline({ mutationId: randomUUID() });");
  assert.equal(check(source).length, 1);
});

test("an empty volatile list is allowed, and uuid.v4 always counts", () => {
  assert.deepEqual(check("runPipeline({ mutationId: randomUUID() });", { volatile: [] }), []);
  assert.equal(check("runPipeline({ mutationId: uuid.v4() });", { volatile: [] }).length, 1);
  assert.equal(check("runPipeline({ mutationId: nanoid() });", { volatile: ["nanoid"] }).length, 1);
  assert.deepEqual(check("runPipeline({ mutationId: nanoid() });", { volatile: undefined }), []);
  assert.throws(() => check("x", { volatile: "nanoid" }), /idempotency\.volatile/);
});

test("a throwaway ledger exempts the call", () => {
  const throwaway = ["InMemoryPipelineLedger"];
  const call = (ledger) => `runPipeline({ pipeline, mutationId: crypto.randomUUID(), state, ledger: ${ledger} }, signal);`;
  assert.deepEqual(check(call("new InMemoryPipelineLedger()"), { throwawayLedgers: throwaway }), []);
  assert.equal(check(call("new PersistentLedger(db)"), { throwawayLedgers: throwaway }).length, 1);
  assert.equal(check(call("new InMemoryPipelineLedger()")).length, 1);
  assert.equal(check("runPipeline({ mutationId: randomUUID() });", { throwawayLedgers: throwaway }).length, 1);
});

test("a throwaway ledger is read through a const and a shorthand", () => {
  const throwaway = ["InMemoryPipelineLedger"];
  const source = lines("function go() {", "  const ledger = new InMemoryPipelineLedger();", "  return runPipeline({ mutationId: randomUUID(), ledger });", "}");
  assert.deepEqual(check(source, { throwawayLedgers: throwaway }), []);
  const durable = lines("function go() {", "  const ledger = openLedger();", "  return runPipeline({ mutationId: randomUUID(), ledger });", "}");
  assert.equal(check(durable, { throwawayLedgers: throwaway }).length, 1);
});

test("the ledger property and the throwaway names come from options", () => {
  const source = "runPipeline({ mutationId: randomUUID(), store: makeScratch() });";
  assert.deepEqual(check(source, { ledgerKey: "store", throwawayLedgers: ["makeScratch"] }), []);
  assert.equal(check(source, { throwawayLedgers: ["makeScratch"] }).length, 1);
});

test("qc check passes the ledger settings of idempotency", async () => {
  const feature = "frontend/src/features/boards";
  const sources = {
    [`${feature}/runner.ts`]: [
      "export const a = () => runPipeline({ mutationId: crypto.randomUUID(), ledger: new InMemoryPipelineLedger() });",
      "export const b = () => runPipeline({ mutationId: crypto.randomUUID(), ledger: new DurableLedger() });",
      "",
    ].join("\n"),
  };
  const overrides = { sagaKey: { runners: ["runPipeline"], key: "mutationId" } };
  const result = await checked({ sources, overrides });
  assert.deepEqual(result.problems.map((problem) => problem.detail.match(/line (\d+)/)[1]), ["2"]);
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
