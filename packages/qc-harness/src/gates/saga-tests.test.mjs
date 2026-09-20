import test from "node:test";
import assert from "node:assert/strict";
import { checkSagaTests, declaredSagas } from "./saga-tests.mjs";

const source = [
  {
    path: "backend/src/features/orders/slices/create.ts",
    contents: "export const createOrderPipeline = definePipeline<CreateOrderState>({ name: 'create' });",
  },
];

test("an exported pipeline is found by the factory that declares it", () => {
  assert.deepEqual(declaredSagas(source), [
    { path: "backend/src/features/orders/slices/create.ts", name: "createOrderPipeline" },
  ]);
});

test("a saga no test names fails", () => {
  const problems = checkSagaTests(declaredSagas(source), []);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "untested-saga");
});

test("a saga named by a headless test passes", () => {
  const tests = [{ path: "a.test.ts", contents: "import { createOrderPipeline } from './create.js';" }];
  assert.deepEqual(checkSagaTests(declaredSagas(source), tests), []);
});

// The gate exists for this case: the workflow is tested, but only through a component,
// so nothing shows it can run without one.
test("a saga only named by a view-bound test fails", () => {
  const tests = [
    {
      path: "a.test.tsx",
      contents: 'import { render } from "react";\nimport { createOrderPipeline } from "./create.js";',
    },
  ];
  const problems = checkSagaTests(declaredSagas(source), tests);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "view-bound-saga");
});

test("one headless test is enough even beside a view-bound one", () => {
  const tests = [
    { path: "a.test.tsx", contents: 'import { render } from "react";\nconst x = createOrderPipeline;' },
    { path: "b.test.ts", contents: "const x = createOrderPipeline;" },
  ];
  assert.deepEqual(checkSagaTests(declaredSagas(source), tests), []);
});

test("the factory list and the view modules come from options", () => {
  const vue = [{ path: "a.ts", contents: "export const flow = defineFlow({});" }];
  assert.deepEqual(declaredSagas(vue, { factories: ["defineFlow"] }), [{ path: "a.ts", name: "flow" }]);
  const tests = [{ path: "a.test.ts", contents: 'import { h } from "vue";\nconst x = flow;' }];
  const problems = checkSagaTests(declaredSagas(vue, { factories: ["defineFlow"] }), tests, {
    viewModules: ["vue"],
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "view-bound-saga");
});

test("a name that merely appears as a substring does not count", () => {
  const tests = [{ path: "a.test.ts", contents: "const x = createOrderPipelineBuilder;" }];
  const problems = checkSagaTests(declaredSagas(source), tests);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "untested-saga");
});

// A runner is how these are actually called; demanding the pipeline's own name
// would fail every correctly-tested workflow. One indirection is followed.
test("a test naming the runner that calls the saga counts", () => {
  const contents = `export const createOrderPipeline = definePipeline({});
export function runCreateOrder(state, signal) {
  return runOnce(createOrderPipeline, state, signal);
}`;
  const sources = [{ path: "slices/create.ts", contents }];
  const sagas = declaredSagas(sources);
  const tests = [{ path: "a.test.ts", contents: "import { runCreateOrder } from './create.js';" }];
  assert.deepEqual(checkSagaTests(sagas, tests, { sources }), []);
});

test("an unrelated exported function in the same file does not count", () => {
  const contents = `export const createOrderPipeline = definePipeline({});
export function unrelatedHelper(x) {
  return x + 1;
}`;
  const sources = [{ path: "slices/create.ts", contents }];
  const tests = [{ path: "a.test.ts", contents: "import { unrelatedHelper } from './create.js';" }];
  const problems = checkSagaTests(declaredSagas(sources), tests, { sources });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "untested-saga");
});
