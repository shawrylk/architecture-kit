import test from "node:test";
import assert from "node:assert/strict";
import { aliasMap, checkExemptHelperCalls, checkTenantPredicate, exemptHelperCalls, unresolvedHelperImports } from "./tenant-predicate.mjs";

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

const CRUD = "backend/src/application/sql/crud.ts";
const helpers = [
  { module: CRUD, name: "insertReturning", argument: 2 },
  { module: CRUD, name: "updateVersionedRow", argument: 3 },
];
const IMPORT = 'import { insertReturning, updateVersionedRow } from "../../../application/sql/crud.js";\n';
const FILE = "backend/src/features/projects/shared/queries.ts";
const calls = (source, options = {}) => checkExemptHelperCalls([{ path: FILE, contents: IMPORT + source }], helpers, options);

test("a call that names the tenant inline passes", () => {
  assert.deepEqual(calls(`return insertReturning(tx, "projects", ["id", "tenant_id", "code"], [a, b, c], COLS, onDup, signal);`), []);
});

test("a call whose columns array just above names the tenant passes", () => {
  const source = `
async function insertProject(tx, input, signal) {
  const columns = ["id", "tenant_id", "code", "name"];
  const values = [input.id, input.tenantId, input.code, input.name];
  return insertReturning(tx, "projects", columns, values, COLS, onDup, signal);
}`;
  assert.deepEqual(calls(source), []);
});

test("a call that forgot the tenant fails, and a tenant in the values beside it does not vouch", () => {
  const source = `
async function insertProject(tx, input, signal) {
  const columns = ["id", "code", "name"];
  const values = [input.id, input.tenantId, input.code, input.name];
  return insertReturning(tx, "projects", columns, values, COLS, onDup, signal);
}`;
  const problems = calls(source);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "unscoped-helper-call");
  assert.equal(problems[0].path, FILE);
});

test("a generic call with a type argument is still matched", () => {
  assert.equal(calls(`return insertReturning<{ id: string }>(tx, "projects", ["id", "code"], [a, b], COLS, onDup);`).length, 1);
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
  assert.equal(calls(source).length, 2);
});

test("a columns factory one call away is followed, and one that forgets the tenant is caught", () => {
  const factory = (columns) => `
function newPhotoColumns() {
  return [${columns}];
}
export async function insertPhoto(tx, input, signal) {
  return insertReturning(tx, "photos", newPhotoColumns(), newPhotoValues(input.tenantId), COLS, onDup, signal);
}`;
  assert.deepEqual(calls(factory('"id", "tenant_id", "delivery_id"')), []);
  assert.equal(calls(factory('"id", "delivery_id"')).length, 1);
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
  const found = calls(source);
  assert.equal(found.length, 1);
  assert.match(found[0].detail, /line 9:/);
});

test("a row object must carry the tenant key: the must-fail and must-pass of the issue", () => {
  const helper = [{ module: CRUD, name: "insertRow", argument: 2 }];
  const run = (source) => checkExemptHelperCalls([{ path: FILE, contents: `import { insertRow } from "../../../application/sql/crud.js";\n${source}` }], helper);
  assert.equal(run('await insertRow(tx, "items", { id, name }, "id");').length, 1);
  assert.deepEqual(run('await insertRow(tx, "items", { tenant_id: tenantId, id, name }, "id");'), []);
});

test("a tenant value argument must name the tenant, so swapped arguments fail", () => {
  assert.deepEqual(calls('return updateVersionedRow(tx, "pins", fields, tenantId, pinId, expectedVersion, COLS, signal);'), []);
  assert.deepEqual(calls('return updateVersionedRow(tx, "pins", fields, input.tenantId, pinId, 3, COLS, signal);'), []);
  assert.equal(calls('return updateVersionedRow(tx, "pins", fields, pinId, tenantId, expectedVersion, COLS, signal);').length, 1);
});

test("only a file that imports the helper from its module is checked, under the name it imports", () => {
  const other = 'import { insertReturning } from "./local.js";\ninsertReturning(tx, "a", ["id"], v, C, f);';
  assert.deepEqual(checkExemptHelperCalls([{ path: FILE, contents: other }], helpers), []);
  const renamed = 'import { insertReturning as insert } from "../../../application/sql/crud.js";\ninsert(tx, "a", ["id"], v, C, f);';
  assert.equal(checkExemptHelperCalls([{ path: FILE, contents: renamed }], helpers).length, 1);
});

test("every call is listed with its verdict, so a reviewer can count them", () => {
  const source = 'insertReturning(tx, "a", ["tenant_id"], v, C, f);\nupdateVersionedRow(tx, "b", f, id, id, 1, C);';
  const found = exemptHelperCalls([{ path: FILE, contents: IMPORT + source }], helpers);
  assert.deepEqual(found.map((call) => [call.name, call.line, call.scoped]), [["insertReturning", 2, true], ["updateVersionedRow", 3, false]]);
});

test("the tenant column and identifier come from options", () => {
  const source = 'insertReturning(tx, "a", ["org_id"], v, C, f);\nupdateVersionedRow(tx, "b", f, orgId, id, 1, C);';
  assert.deepEqual(calls(source, { column: "org_id", identifier: "orgId" }), []);
  assert.equal(calls(source).length, 2);
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

test("the tenant column comes from options", () => {
  const resources = [
    { path: "a/resource.ts", statements: [{ sql: "select * from pins where org_id = $1", bound: new Set() }] },
  ];
  const owned = new Set(["pins"]);
  assert.deepEqual(checkTenantPredicate(resources, owned, { column: "org_id" }), []);
  const problems = checkTenantPredicate(resources, owned, { column: "tenant_id" });
  assert.equal(problems.length, 1);
  assert.ok(problems[0].detail.includes("tenant_id"));
});

// An exempt helper imported in a form the gate cannot read skipped the check silently. A path alias
// resolves through the tsconfig, a namespace member call counts, and what the gate cannot read fails.

const TSCONFIG = `{
  // comments and trailing commas are legal in a tsconfig
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@/*": ["backend/src/*"], "@crud": ["backend/src/application/sql/crud.ts"], },
  },
}`;
const aliases = aliasMap(TSCONFIG);
const ALIAS_IMPORT = 'import { insertReturning } from "@/application/sql/crud.js";\n';
const at = (contents, path = FILE) => [{ path, contents }];
const both = (contents, options = {}) => [
  ...checkExemptHelperCalls(at(contents), helpers, options),
  ...unresolvedHelperImports(at(contents), helpers, options),
];

test("an alias import resolves through tsconfig paths and its call is checked", () => {
  const bad = `${ALIAS_IMPORT}insertReturning(tx, "a", ["id"], v, C, f);`;
  const problems = both(bad, { aliases });
  assert.deepEqual(problems.map((problem) => problem.rule), ["unscoped-helper-call"]);
  assert.deepEqual(both(`${ALIAS_IMPORT}insertReturning(tx, "a", ["tenant_id"], v, C, f);`, { aliases }), []);
});

test("an exact alias, and a baseUrl-relative specifier, resolve too", () => {
  const exact = 'import { insertReturning } from "@crud";\ninsertReturning(tx, "a", ["id"], v, C, f);';
  assert.equal(both(exact, { aliases }).length, 1);
  const based = aliasMap('{"compilerOptions":{"baseUrl":"backend/src"}}');
  const bare = 'import { insertReturning } from "application/sql/crud";\ninsertReturning(tx, "a", ["id"], v, C, f);';
  assert.deepEqual(both(bare, { aliases: based }).map((problem) => problem.rule), ["unscoped-helper-call"]);
});

test("a tsconfig in a folder resolves its targets from that folder", () => {
  const nested = aliasMap('{"compilerOptions":{"paths":{"@/*":["src/*"]}}}', "backend");
  const source = `${ALIAS_IMPORT}insertReturning(tx, "a", ["id"], v, C, f);`;
  assert.deepEqual(both(source, { aliases: nested }).map((problem) => problem.rule), ["unscoped-helper-call"]);
});

test("a tsconfig with no paths yields no aliases, and one that does not parse is an error", () => {
  assert.deepEqual(aliasMap('{"compilerOptions":{}}'), []);
  assert.throws(() => aliasMap("{ not json"), /tsconfig/);
});

test("a namespace member call is checked", () => {
  const head = 'import * as crud from "../../../application/sql/crud.js";\n';
  assert.deepEqual(both(`${head}crud.insertReturning(tx, "a", ["id", "tenant_id"], v, C, f);`), []);
  const found = exemptHelperCalls(at(`${head}crud.insertReturning(tx, "a", ["tenant_id"], v, C, f);\ncrud.updateVersionedRow(tx, "b", f, id, id, 1, C);`), helpers);
  assert.deepEqual(found.map((call) => [call.name, call.line, call.scoped]), [["insertReturning", 2, true], ["updateVersionedRow", 3, false]]);
});

test("an unscoped namespace call fails as unscoped-helper-call", () => {
  const source = 'import * as crud from "../../../application/sql/crud.js";\ncrud.insertReturning(tx, "a", ["id"], v, C, f);';
  const problems = both(source);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "unscoped-helper-call");
  assert.match(problems[0].detail, /line 2:/);
});

test("a namespace call through an alias is checked, and another object's method of that name is not", () => {
  const source = 'import * as crud from "@/application/sql/crud.js";\ncrud.insertReturning(tx, "a", ["id"], v, C, f);\nother.insertReturning(tx, "a", ["id"], v, C, f);';
  assert.equal(both(source, { aliases }).length, 1);
});

test("a barrel re-export import fails as unresolved-helper-import, naming file and specifier", () => {
  const source = 'import { insertReturning } from "../../../application/sql/index.js";\ninsertReturning(tx, "a", ["id"], v, C, f);';
  const problems = unresolvedHelperImports(at(source), helpers);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "unresolved-helper-import");
  assert.equal(problems[0].path, FILE);
  assert.match(problems[0].detail, /\.\.\/\.\.\/\.\.\/application\/sql\/index\.js/);
  assert.match(problems[0].detail, /insertReturning/);
});

test("a namespace import of a barrel folder fails, and an unrelated namespace import does not", () => {
  const barrel = 'import * as sql from "../../../application/sql";\nsql.insertReturning(tx, "a", ["id"], v, C, f);';
  assert.deepEqual(unresolvedHelperImports(at(barrel), helpers).map((problem) => problem.rule), ["unresolved-helper-import"]);
  const unrelated = 'import * as z from "zod";\nimport * as path from "node:path";\nimport * as ui from "./ui.js";';
  assert.deepEqual(unresolvedHelperImports(at(unrelated), helpers), []);
});

test("an alias with no tsconfig fails as unresolved-helper-import", () => {
  const source = `${ALIAS_IMPORT}insertReturning(tx, "a", ["id"], v, C, f);`;
  const problems = unresolvedHelperImports(at(source), helpers);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "unresolved-helper-import");
  assert.match(problems[0].detail, /@\/application\/sql\/crud\.js/);
  assert.match(problems[0].detail, /tsconfig/);
  assert.equal(unresolvedHelperImports(at(source), helpers, { aliases: [] }).length, 1);
});

test("an alias no path pattern covers fails even with a tsconfig", () => {
  const source = 'import { insertReturning } from "~/sql/crud.js";';
  assert.equal(unresolvedHelperImports(at(source), helpers, { aliases }).length, 1);
});

test("a relative named import still behaves as before", () => {
  const direct = `${IMPORT}insertReturning(tx, "a", ["id"], v, C, f);`;
  assert.deepEqual(both(direct).map((problem) => problem.rule), ["unscoped-helper-call"]);
  const renamed = 'import { insertReturning as insert } from "../../../application/sql/crud.js";\ninsert(tx, "a", ["id"], v, C, f);';
  assert.deepEqual(both(renamed).map((problem) => problem.rule), ["unscoped-helper-call"]);
  const multiline = 'import {\n  updateVersionedRow,\n  insertReturning,\n} from "../../../application/sql/crud.js";\ninsertReturning(tx, "a", ["tenant_id"], v, C, f);';
  assert.deepEqual(both(multiline), []);
  assert.deepEqual(unresolvedHelperImports(at(IMPORT), helpers), []);
});

test("a file that imports neither helper, nor anything like them, reports nothing", () => {
  assert.deepEqual(both('import { other } from "@/x/y.js";\nother(1);', { aliases }), []);
  assert.deepEqual(both("const insertReturning = 1;"), []);
});

// A barrel that renames the helper hides every call from the name match. The gate reads a local
// barrel one level, maps the renamed export back to the helper, and checks the calls.

const BARREL = "backend/src/application/sql/index.ts";
const BARREL_SPECIFIER = "../../../application/sql/index.js";
const viaBarrel = (barrel, caller, options = {}) => {
  const files = [{ path: BARREL, contents: barrel }, { path: FILE, contents: caller }];
  return [...checkExemptHelperCalls(files, helpers, options), ...unresolvedHelperImports(files, helpers, options)];
};

test("a renamed re-export in a barrel is followed, and its call is checked", () => {
  const barrel = 'export { insertReturning as insertRow } from "./crud.js";\n';
  const bad = `import { insertRow } from "${BARREL_SPECIFIER}";\ninsertRow(tx, "a", ["id"], v, C, f);`;
  const problems = viaBarrel(barrel, bad);
  assert.deepEqual(problems.map((problem) => problem.rule), ["unscoped-helper-call"]);
  assert.equal(problems[0].path, FILE);
  const good = `import { insertRow as put } from "${BARREL_SPECIFIER}";\nput(tx, "a", ["id", "tenant_id"], v, C, f);`;
  assert.deepEqual(viaBarrel(barrel, good), []);
});

test("an export-star barrel keeps the helper's name, and its call is checked", () => {
  const barrel = 'export * from "./crud.js";\nexport * from "./other.js";\n';
  const bad = `import { insertReturning } from "${BARREL_SPECIFIER}";\ninsertReturning(tx, "a", ["id"], v, C, f);`;
  assert.deepEqual(viaBarrel(barrel, bad).map((problem) => problem.rule), ["unscoped-helper-call"]);
});

test("a barrel that imports the helper and exports it under another name is followed", () => {
  const barrel = 'import { insertReturning } from "./crud.js";\nexport { insertReturning as insertRow };\n';
  const bad = `import { insertRow } from "${BARREL_SPECIFIER}";\ninsertRow(tx, "a", ["id"], v, C, f);`;
  assert.deepEqual(viaBarrel(barrel, bad).map((problem) => problem.rule), ["unscoped-helper-call"]);
});

test("a barrel that names its source by alias is followed", () => {
  const barrel = 'export { insertReturning as insertRow } from "@/application/sql/crud.js";\n';
  const bad = `import { insertRow } from "${BARREL_SPECIFIER}";\ninsertRow(tx, "a", ["id"], v, C, f);`;
  assert.deepEqual(viaBarrel(barrel, bad, { aliases }).map((problem) => problem.rule), ["unscoped-helper-call"]);
  assert.deepEqual(viaBarrel(barrel, bad).map((problem) => problem.rule), ["unresolved-helper-import"]);
});

test("a namespace import of a barrel that names neither the module nor a folder above it is followed", () => {
  const barrel = 'export * from "./sql/crud.js";\n';
  const source = 'import * as db from "../../../application/db.js";\ndb.insertReturning(tx, "a", ["id"], v, C, f);\ndb.other(1);';
  const files = [{ path: "backend/src/application/db.ts", contents: barrel }, { path: FILE, contents: source }];
  assert.deepEqual(checkExemptHelperCalls(files, helpers).map((problem) => problem.rule), ["unscoped-helper-call"]);
  assert.deepEqual(unresolvedHelperImports(files, helpers), []);
});

test("a namespace re-export of the module is followed", () => {
  const barrel = 'export * as crud from "./crud.js";\n';
  const source = `import { crud } from "${BARREL_SPECIFIER}";\ncrud.insertReturning(tx, "a", ["id"], v, C, f);`;
  assert.deepEqual(viaBarrel(barrel, source).map((problem) => problem.rule), ["unscoped-helper-call"]);
});

test("a barrel that does not re-export the helper does not vouch for its name", () => {
  const barrel = 'export { other } from "./other.js";\n';
  const source = `import { insertReturning } from "${BARREL_SPECIFIER}";\ninsertReturning(tx, "a", ["id"], v, C, f);`;
  assert.deepEqual(viaBarrel(barrel, source).map((problem) => problem.rule), ["unresolved-helper-import"]);
});

test("a barrel the gate cannot read still fails closed", () => {
  const source = `import { insertReturning } from "${BARREL_SPECIFIER}";`;
  assert.deepEqual(unresolvedHelperImports(at(source), helpers).map((problem) => problem.rule), ["unresolved-helper-import"]);
});
