import test from "node:test";
import assert from "node:assert/strict";
import { checkSharedInsertCallSites, checkTenantPredicate } from "./tenant-predicate.mjs";

const owned = new Set(["projects", "pin_annotations"]);
const one = (sql, bound = new Set()) => [{ path: "r.ts", statements: [{ sql, bound }] }];

test("a scoped read passes", () => {
  assert.deepEqual(checkTenantPredicate(one("select id from projects where tenant_id = $1"), owned), []);
});

test("a read with no tenant predicate is a finding, and names the table", () => {
  const problems = checkTenantPredicate(one("select id from projects where id = $1"), owned);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "unscoped-statement");
  assert.match(problems[0].detail, /'projects'/);
});

test("an insert that does not carry the tenant is a finding", () => {
  const problems = checkTenantPredicate(one("insert into projects (id, code) values ($1, $2)"), owned);
  assert.equal(problems.length, 1);
});

test("an update that does not carry the tenant is a finding", () => {
  const problems = checkTenantPredicate(one("update pin_annotations set name = $1 where id = $2"), owned);
  assert.equal(problems.length, 1);
});

test("a statement reading only a common table expression needs no predicate", () => {
  const bound = new Set(["projects"]);
  assert.deepEqual(checkTenantPredicate(one("select id from projects", bound), owned), []);
});

test("a statement touching no business table is left alone", () => {
  assert.deepEqual(checkTenantPredicate(one("select current_setting('app.tenant_id')"), owned), []);
});

test("a table whose name merely starts the same is not matched", () => {
  assert.deepEqual(checkTenantPredicate(one("select id from projects_archive where id = $1"), owned), []);
});

test("a shared insert naming the tenant inline passes", () => {
  const source = `return insertReturning(tx, "projects", ["id", "tenant_id", "code"], [a, b, c], COLS, onDup, signal);`;
  assert.deepEqual(checkSharedInsertCallSites([{ path: "r.ts", source }]), []);
});

test("a shared insert naming the tenant in a columns array just above passes", () => {
  const source = `
async function insertProject(tx, input, signal) {
  const columns = ["id", "tenant_id", "code", "name"];
  const values = [input.id, input.tenantId, input.code, input.name];
  return insertReturning(tx, "projects", columns, values, COLS, onDup, signal);
}`;
  assert.deepEqual(checkSharedInsertCallSites([{ path: "r.ts", source }]), []);
});

test("a shared insert that forgot the tenant is caught", () => {
  const source = `
async function insertProject(tx, input, signal) {
  const columns = ["id", "code", "name"];
  const values = [input.id, input.code, input.name];
  return insertReturning(tx, "projects", columns, values, COLS, onDup, signal);
}`;
  const problems = checkSharedInsertCallSites([{ path: "r.ts", source }]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "insert-without-tenant");
});

test("a generic call with a type argument is still matched", () => {
  const source = `return insertReturning<ProjectRow>(tx, "projects", ["id", "code"], [a, b], COLS, onDup);`;
  assert.equal(checkSharedInsertCallSites([{ path: "r.ts", source }]).length, 1);
});

test("every call is checked, and a neighbour naming the tenant cannot vouch for one that does not", () => {
  const source = `
function insertA(tx, v) {
  return insertReturning(tx, "a", ["id", "tenant_id"], v, C, f);
}
function insertB(tx, v) {
  return insertReturning(tx, "b", ["id"], v, C, f);
}
function insertC(tx, v) {
  return insertReturning(tx, "c", ["id"], v, C, f);
}`;
  assert.equal(checkSharedInsertCallSites([{ path: "r.ts", source }]).length, 2);
});

test("a columns factory one call away is followed, not guessed at", () => {
  const source = `
function newPhotoColumns() {
  return ["id", "tenant_id", "delivery_id"];
}
export async function insertPhoto(tx, input, signal) {
  return insertReturning(tx, "photos", newPhotoColumns(), newPhotoValues(input), COLS, onDup, signal);
}`;
  assert.deepEqual(checkSharedInsertCallSites([{ path: "r.ts", source }]), []);
});

test("a columns factory that forgets the tenant is still caught through the indirection", () => {
  const source = `
function newPhotoColumns() {
  return ["id", "delivery_id"];
}
export async function insertPhoto(tx, input, signal) {
  return insertReturning(tx, "photos", newPhotoColumns(), newPhotoValues(input), COLS, onDup, signal);
}`;
  assert.equal(checkSharedInsertCallSites([{ path: "r.ts", source }]).length, 1);
});

test("a repeated local name is not resolved to the first one in the file", () => {
  const source = `
export async function insertOne(tx, input, signal) {
  const columns = ["id", "tenant_id", "name"];
  return insertReturning(tx, "a", columns, values(input), COLS, onDup, signal);
}
export async function insertTwo(tx, input, signal) {
  const columns = ["id", "name"];
  return insertReturning(tx, "b", columns, values(input), COLS, onDup, signal);
}`;
  const found = checkSharedInsertCallSites([{ path: "r.ts", source }]);
  assert.equal(found.length, 1);
  assert.match(found[0].detail, /line 8:/);
});


test("a statement on a table named at runtime is still checked", () => {
  const sql = "select id from ${table} where id = $1";
  const problems = checkTenantPredicate(one(sql), owned);
  assert.equal(problems.length, 1);
  assert.match(problems[0].detail, /named at runtime/);
});

test("a runtime-named table that does carry the tenant passes", () => {
  const sql = "select id from ${table} where tenant_id = $1 and client_mutation_id = $2";
  assert.deepEqual(checkTenantPredicate(one(sql), owned), []);
});

test("an insert into a runtime-named table must list the tenant column", () => {
  const bad = "insert into ${table} (id, name) values ($1, $2)";
  assert.equal(checkTenantPredicate(one(bad), owned).length, 1);
  const good = "insert into ${table} (id, tenant_id, name) values ($1, $2, $3)";
  assert.deepEqual(checkTenantPredicate(one(good), owned), []);
});

test("the tenant column and the shared insert helper come from options", () => {
  const resources = [
    { path: "a/resource.ts", statements: [{ sql: "select * from pins where org_id = $1", bound: new Set() }] },
  ];
  const owned = new Set(["pins"]);
  assert.deepEqual(checkTenantPredicate(resources, owned, { column: "org_id" }), []);
  const problems = checkTenantPredicate(resources, owned, { column: "tenant_id" });
  assert.equal(problems.length, 1);
  assert.ok(problems[0].detail.includes("tenant_id"));
});

test("a renamed shared insert helper is still followed to its call sites", () => {
  const resources = [{ path: "a/resource.ts", source: 'await addRow(uow, "pins", ["name"], [n]);' }];
  const problems = checkSharedInsertCallSites(resources, { insertHelper: "addRow", column: "org_id" });
  assert.equal(problems.length, 1);
  assert.ok(problems[0].detail.includes("org_id"));
});
