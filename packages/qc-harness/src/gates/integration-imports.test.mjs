import test from "node:test";
import assert from "node:assert/strict";
import { checkIntegrationImports, productImportCount } from "./integration-imports.mjs";

const options = { productRoots: ["backend", "frontend"], productPackages: ["^@app/(?:domain|contracts)(?:/|$)"] };

test("an integration test that imports only the runner and the kernel fails", () => {
  const contents = 'import { test } from "vitest";\nimport { ok } from "@app/kernel";\ntest("x", () => {});\n';
  const problems = checkIntegrationImports([{ path: "packages/journeys/src/flow.interop.test.ts", contents }], options);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "integration-without-product");
  assert.equal(problems[0].path, "packages/journeys/src/flow.interop.test.ts");
});

test("a product package, a climb into a product root, or any relative import inside one counts", () => {
  assert.equal(productImportCount('import { Pin } from "@app/domain/pin";', "packages/x/a.live.test.ts", options), 1);
  assert.equal(productImportCount('import { app } from "../../backend/src/main.js";', "packages/x/a.live.test.ts", options), 1);
  assert.equal(productImportCount('import { route } from "./route.js";', "backend/src/pins/a.live.test.ts", options), 1);
  assert.equal(productImportCount('import { helper } from "./helper.js";', "packages/x/a.live.test.ts", options), 0);
});

test("a product root named in a comment or a string is not an import", () => {
  const contents = '// see backend/src/main.ts\nimport { test } from "vitest";\nconst path = "@app/domain";\n';
  assert.equal(checkIntegrationImports([{ path: "packages/x/a.interop.test.ts", contents }], options).length, 1);
});

test("with no integration test at all the gate says it checks nothing", () => {
  const problems = checkIntegrationImports([], options);
  assert.deepEqual(problems.map((problem) => problem.rule), ["no-integration-tests"]);
});

test("a test that reaches the product passes", () => {
  const contents = 'import { test } from "vitest";\nimport { createPin } from "@app/domain";\n';
  assert.deepEqual(checkIntegrationImports([{ path: "packages/x/a.interop.test.ts", contents }], options), []);
});
