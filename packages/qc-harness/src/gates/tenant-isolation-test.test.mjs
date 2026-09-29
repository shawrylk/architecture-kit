import test from "node:test";
import assert from "node:assert/strict";
import { checkTenantIsolationTests } from "./tenant-isolation-test.mjs";

const ROOTS = ["backend/src/features"];
const options = { helper: "expectTenantIsolation", featureRoots: ROOTS };

const schema = (feature) => ({
  path: `backend/src/features/${feature}/schema.ts`,
  contents: 'export const orders = pgTable("orders", { id: uuid("id"), tenantId: uuid("tenant_id") });',
});

test("a feature with a tenant table and no helper call fails", () => {
  const files = [schema("orders"), { path: "backend/src/features/orders/create.test.ts", contents: "test('x', () => {});" }];
  const problems = checkTenantIsolationTests(files, options);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "untested-tenant-isolation");
  assert.equal(problems[0].path, "backend/src/features/orders");
  assert.ok(problems[0].detail.includes("orders"));
  assert.ok(problems[0].detail.includes("expectTenantIsolation"));
});

test("a feature whose test calls the helper passes", () => {
  const files = [
    schema("orders"),
    { path: "backend/src/features/orders/isolation.test.ts", contents: "await expectTenantIsolation(repo);" },
  ];
  assert.deepEqual(checkTenantIsolationTests(files, options), []);
});

test("a feature with no tenant table is ignored", () => {
  const files = [
    { path: "backend/src/features/health/schema.ts", contents: 'export const pings = pgTable("pings", { id: uuid("id") });' },
  ];
  assert.deepEqual(checkTenantIsolationTests(files, options), []);
});

test("a test in another feature does not count", () => {
  const files = [
    schema("orders"),
    { path: "backend/src/features/billing/isolation.test.ts", contents: "await expectTenantIsolation(repo);" },
  ];
  const problems = checkTenantIsolationTests(files, options);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].path, "backend/src/features/orders");
});

test("a null helper is reported", () => {
  const files = [schema("orders")];
  const problems = checkTenantIsolationTests(files, { ...options, helper: null });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "isolation-helper-unset");
});

test("a helper name inside a longer identifier does not count", () => {
  const files = [
    schema("orders"),
    { path: "backend/src/features/orders/a.test.ts", contents: "expectTenantIsolationLater(repo);" },
  ];
  assert.equal(checkTenantIsolationTests(files, options).length, 1);
});

test("a table in a source file that is itself a test is not a declaration", () => {
  const files = [
    { path: "backend/src/features/orders/fixture.test.ts", contents: schema("orders").contents },
  ];
  assert.deepEqual(checkTenantIsolationTests(files, { ...options, helper: "h" }), []);
});

test("a file outside every feature root is ignored", () => {
  const files = [{ path: "backend/src/shared/schema.ts", contents: schema("x").contents }];
  assert.deepEqual(checkTenantIsolationTests(files, options), []);
});

test("the table factory and column come from the options", () => {
  const files = [
    {
      path: "backend/src/features/orders/schema.ts",
      contents: 'export const orders = table("orders", { orgId: uuid("org_id") });',
    },
  ];
  assert.equal(checkTenantIsolationTests(files, { ...options, tableFactory: "table", column: "orgId" }).length, 1);
  assert.deepEqual(checkTenantIsolationTests(files, options), []);
});

const withTest = (contents) => [
  schema("orders"),
  { path: "backend/src/features/orders/isolation.test.ts", contents },
];

test("an import of the helper with no call fails", () => {
  const files = withTest('import { expectTenantIsolation } from "../../testing/tenancy";');
  assert.equal(checkTenantIsolationTests(files, options).length, 1);
});

test("a line comment naming the helper fails", () => {
  const files = withTest("// TODO: expectTenantIsolation(repo) once the fixture exists");
  assert.equal(checkTenantIsolationTests(files, options).length, 1);
});

test("a block comment naming the helper fails", () => {
  const files = withTest("/*\n * expectTenantIsolation(repo);\n */\ntest('x', () => {});");
  assert.equal(checkTenantIsolationTests(files, options).length, 1);
});

test("a call through a namespace passes", () => {
  const files = withTest("await helpers.expectTenantIsolation(repo);");
  assert.deepEqual(checkTenantIsolationTests(files, options), []);
});

test("a call with type arguments passes", () => {
  const files = withTest("await expectTenantIsolation<Order>(repo);");
  assert.deepEqual(checkTenantIsolationTests(files, options), []);
});

test("a call after a comment on an earlier line passes", () => {
  const files = withTest("// the two-tenant proof\nawait expectTenantIsolation(repo);");
  assert.deepEqual(checkTenantIsolationTests(files, options), []);
});

test("a local redefinition of the helper fails", () => {
  for (const contents of [
    "function expectTenantIsolation(repo) { return true; }",
    "async function expectTenantIsolation(repo) {}",
    "const expectTenantIsolation = (repo) => true;",
  ]) {
    assert.equal(checkTenantIsolationTests(withTest(contents), options).length, 1, contents);
  }
});
