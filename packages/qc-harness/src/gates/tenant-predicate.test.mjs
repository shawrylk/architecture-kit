import test from "node:test";
import assert from "node:assert/strict";
import * as gate from "./tenant-predicate.mjs";

const { aliasMap, checkExemptHelperCalls, checkTenantPredicate, exemptHelperCalls, unresolvedHelperImports } = gate;

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
  const other = { path: BARREL.replace("index", "other"), contents: "export const x = 1;\n" };
  const files = [{ path: BARREL, contents: barrel }, other, { path: FILE, contents: bad }];
  const problems = [...checkExemptHelperCalls(files, helpers), ...unresolvedHelperImports(files, helpers)];
  assert.deepEqual(problems.map((problem) => problem.rule), ["unscoped-helper-call"]);
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

// A barrel is followed as far as it goes: through any number of barrels up to a cap, past a cycle,
// and never into silence. What the gate cannot trace fails closed.

const SQL = "backend/src/application/sql";
const withFiles = (barrels, caller, options = {}) => {
  const files = [...Object.entries(barrels).map(([path, contents]) => ({ path, contents })), { path: FILE, contents: caller }];
  return [...checkExemptHelperCalls(files, helpers, options), ...unresolvedHelperImports(files, helpers, options)].map((problem) => problem.rule);
};
const importFrom = (name) => `import { ${name} } from "${BARREL_SPECIFIER}";\n${name}(tx, "a", ["id"], v, C, f);`;

test("a helper renamed through two barrels is checked", () => {
  const barrels = {
    [`${SQL}/index.ts`]: 'export { insertRow as put } from "./inner.js";\n',
    [`${SQL}/inner.ts`]: 'export { insertReturning as insertRow } from "./crud.js";\n',
  };
  assert.deepEqual(withFiles(barrels, importFrom("put")), ["unscoped-helper-call"]);
  const good = `import { put } from "${BARREL_SPECIFIER}";\nput(tx, "a", ["tenant_id"], v, C, f);`;
  assert.deepEqual(withFiles(barrels, good), []);
});

test("a helper reached by export-star through one barrel and renamed in the next is checked", () => {
  const barrels = {
    [`${SQL}/index.ts`]: 'export * from "./inner.js";\n',
    [`${SQL}/inner.ts`]: 'export { insertReturning as insertRow } from "./crud.js";\n',
  };
  assert.deepEqual(withFiles(barrels, importFrom("insertRow")), ["unscoped-helper-call"]);
});

test("a barrel that imports another barrel and exports the name under a new one is followed", () => {
  const barrels = {
    [`${SQL}/index.ts`]: 'import { insertRow } from "./inner.js";\nexport { insertRow as put };\n',
    [`${SQL}/inner.ts`]: 'export { insertReturning as insertRow } from "./crud.js";\n',
  };
  assert.deepEqual(withFiles(barrels, importFrom("put")), ["unscoped-helper-call"]);
});

test("a barrel cycle ends, and the helper reachable around it is still found", () => {
  const barrels = {
    [`${SQL}/index.ts`]: 'export * from "./loop.js";\nexport { insertReturning as put } from "./crud.js";\n',
    [`${SQL}/loop.ts`]: 'export * from "./index.js";\n',
  };
  assert.deepEqual(withFiles(barrels, importFrom("put")), ["unscoped-helper-call"]);
  const cyclic = { [`${SQL}/index.ts`]: 'export * from "./loop.js";\n', [`${SQL}/loop.ts`]: 'export * from "./index.js";\n' };
  assert.deepEqual(withFiles(cyclic, importFrom("other")), []);
});

/** A chain of `count` barrels; the last renames the helper, and each above it re-exports with a star. */
function chain(count) {
  const barrels = {};
  for (let i = 1; i < count; i += 1) barrels[`${SQL}/${i === 1 ? "index" : `n${i}`}.ts`] = `export * from "./n${i + 1}.js";\n`;
  barrels[`${SQL}/${count === 1 ? "index" : `n${count}`}.ts`] = 'export { insertReturning as insertRow } from "./crud.js";\n';
  return barrels;
}

test("a chain of barrels is followed to any length, since the step budget bounds the work", () => {
  assert.deepEqual(withFiles(chain(8), importFrom("insertRow")), ["unscoped-helper-call"]);
  assert.deepEqual(withFiles(chain(9), importFrom("insertRow")), ["unscoped-helper-call"]);
  assert.deepEqual(withFiles(chain(200), importFrom("insertRow")), ["unscoped-helper-call"]);
});

test("a barrel that exports a name from a module the gate cannot read fails closed for that name", () => {
  const barrels = { [`${SQL}/index.ts`]: 'export { foo as put } from "../../../outside/lib.js";\nexport { bar } from "./crud.js";\n' };
  assert.deepEqual(withFiles(barrels, importFrom("put")), ["unresolved-helper-import"]);
  assert.deepEqual(withFiles(barrels, importFrom("bar")), []);
});

test("an export-star from a module the gate cannot read fails closed for every name", () => {
  const barrels = { [`${SQL}/index.ts`]: 'export * from "../../../outside/lib.js";\n' };
  assert.deepEqual(withFiles(barrels, importFrom("anything")), ["unresolved-helper-import"]);
});

test("a module the scan knows re-exports nothing, an asset is not a module, and a package is left alone", () => {
  const barrel = 'export { foo as put } from "./known.js";\nexport { logo } from "./logo.svg";\nexport * from "zod";\n';
  const barrels = { [`${SQL}/index.ts`]: barrel };
  const leaves = new Set([`${SQL}/known.ts`]);
  assert.deepEqual(withFiles(barrels, importFrom("put"), { leaves }), []);
  assert.deepEqual(withFiles(barrels, importFrom("logo"), { leaves }), []);
  assert.deepEqual(withFiles(barrels, importFrom("put")), ["unresolved-helper-import"]);
});

test("every importer of one barrel is checked, not only the first", () => {
  const barrels = { [`${SQL}/index.ts`]: 'export { insertReturning as put } from "./crud.js";\n' };
  const files = [
    ...Object.entries(barrels).map(([path, contents]) => ({ path, contents })),
    { path: FILE, contents: importFrom("put") },
    { path: "backend/src/features/projects/shared/other.ts", contents: importFrom("put") },
  ];
  assert.equal(checkExemptHelperCalls(files, helpers).length, 2);
});

// The gate parses each file once into a module record, then finds where the helper's names go by a
// fixed point over the module graph. A cycle, a namespace, an alias, a default and a missing space
// all resolve. What it cannot follow makes the module opaque, and a caller of an opaque module fails.

const modulesAt = (modules) => Object.fromEntries(Object.entries(modules).map(([name, contents]) => [`${SQL}/${name}.ts`, contents]));
const specifierOf = (name) => `../../../application/sql/${name}.js`;
const badCall = (call) => `${call}(tx, "a", ["id"], v, C, f);`;
/** The rules found for a caller that imports from a module of `modules`. */
const found = (modules, caller, options = {}) => withFiles(modulesAt(modules), caller, options);
const UNSCOPED = ["unscoped-helper-call"];
const UNRESOLVED = ["unresolved-helper-import"];

test("a cycle keeps its names: a rename that a star export feeds back through the same cycle", () => {
  const modules = {
    A: 'export * from "./B.js";\nexport { insertReturning as put } from "./crud.js";\n',
    B: 'export { put as q } from "./A.js";\n',
  };
  assert.deepEqual(found(modules, `import { q } from "${specifierOf("A")}";\n${badCall("q")}`), UNSCOPED);
  assert.deepEqual(found(modules, `import { q } from "${specifierOf("B")}";\n${badCall("q")}`), UNSCOPED);
});

test("a cycle keeps its names: a ring of stars, and a rename through a member of the ring", () => {
  const ring = {
    A: 'export * from "./B.js";\n',
    B: 'export * from "./A.js";\nexport { insertReturning as put } from "./crud.js";\n',
  };
  assert.deepEqual(found(ring, `import { put } from "${specifierOf("A")}";\n${badCall("put")}`), UNSCOPED);
  const rename = {
    A: 'export { y as w } from "./B.js";\nexport * from "./B.js";\n',
    B: 'export { put as y } from "./A.js";\nexport { insertReturning as put } from "./crud.js";\n',
  };
  assert.deepEqual(found(rename, `import { w } from "${specifierOf("A")}";\n${badCall("w")}`), UNSCOPED);
  const three = {
    A: 'export * from "./B.js";\n',
    B: 'export { z as y } from "./C.js";\n',
    C: 'export { insertReturning as z } from "./crud.js";\nexport * from "./A.js";\n',
  };
  assert.deepEqual(found(three, `import { y } from "${specifierOf("A")}";\n${badCall("y")}`), UNSCOPED);
});

test("a cycle with a scoped call passes, and a cycle that reaches no helper reports nothing", () => {
  const modules = { A: 'export * from "./B.js";\nexport { insertReturning as put } from "./crud.js";\n', B: 'export { put as q } from "./A.js";\n' };
  assert.deepEqual(found(modules, `import { q } from "${specifierOf("B")}";\nq(tx, "a", ["tenant_id"], v, C, f);`), []);
  const empty = { A: 'export * from "./B.js";\n', B: 'export * from "./A.js";\n' };
  assert.deepEqual(found(empty, `import { other } from "${specifierOf("A")}";\n${badCall("other")}`), []);
});

test("a member of a namespace that a barrel re-exports is checked: b.crud.insertReturning(", () => {
  const modules = { index: 'export * as crud from "./crud.js";\n' };
  const viaNamespace = `import * as b from "${specifierOf("index")}";\n${badCall("b.crud.insertReturning")}`;
  assert.deepEqual(found(modules, viaNamespace), UNSCOPED);
  const viaName = `import { crud } from "${specifierOf("index")}";\n${badCall("crud.insertReturning")}`;
  assert.deepEqual(found(modules, viaName), UNSCOPED);
  const good = `import * as b from "${specifierOf("index")}";\nb.crud.insertReturning(tx, "a", ["tenant_id"], v, C, f);`;
  assert.deepEqual(found(modules, good), []);
});

test("a namespace nested two barrels deep is checked: db.crud.insertReturning(", () => {
  const modules = { inner: 'export * as crud from "./crud.js";\n', index: 'export * as db from "./inner.js";\n' };
  assert.deepEqual(found(modules, `import { db } from "${specifierOf("index")}";\n${badCall("db.crud.insertReturning")}`), UNSCOPED);
  assert.deepEqual(found(modules, `import * as all from "${specifierOf("index")}";\n${badCall("all.db.crud.insertReturning")}`), UNSCOPED);
});

test("an alias by export const is followed, for a name and for a member of a namespace", () => {
  const byName = { index: 'import { insertReturning } from "./crud.js";\nexport const insertRow = insertReturning;\n' };
  assert.deepEqual(found(byName, `import { insertRow } from "${specifierOf("index")}";\n${badCall("insertRow")}`), UNSCOPED);
  const byMember = { index: 'import * as crud from "./crud.js";\nexport const insertRow = crud.insertReturning;\n' };
  assert.deepEqual(found(byMember, `import { insertRow } from "${specifierOf("index")}";\n${badCall("insertRow")}`), UNSCOPED);
});

test("a module that aliases the helper in its own body is opaque, and it fails as a file too", () => {
  const source = `import { insertReturning } from "${specifierOf("crud")}";\nconst f = insertReturning;\n${badCall("f")}`;
  assert.deepEqual(withFiles({}, source), UNRESOLVED);
  const destructured = `import * as crud from "${specifierOf("crud")}";\nconst { insertReturning: put } = crud;\n${badCall("put")}`;
  assert.deepEqual(withFiles({}, destructured), UNRESOLVED);
  const wrapped = `import { insertReturning } from "${specifierOf("crud")}";\nexport const insertRow = wrap(insertReturning);\n`;
  assert.deepEqual(withFiles({}, wrapped), UNRESOLVED);
});

test("a caller that imports from an opaque module fails, for any name and for a namespace", () => {
  const modules = { index: 'import { insertReturning } from "./crud.js";\nexport const insertRow = wrap(insertReturning);\nexport const other = 1;\n' };
  assert.deepEqual(found(modules, `import { other } from "${specifierOf("index")}";\n`).slice(-1), UNRESOLVED);
  assert.deepEqual(found(modules, `import * as all from "${specifierOf("index")}";\n`).slice(-1), UNRESOLVED);
});

test("a helper that is only called, exported in a list, or named in a comment, a string or a typeof is not opaque", () => {
  const modules = { index: 'import { insertReturning } from "./crud.js";\nexport { insertReturning as put };\n' };
  assert.deepEqual(found(modules, `import { put } from "${specifierOf("index")}";\n${badCall("put")}`), UNSCOPED);
  const called = `import { insertReturning } from "${specifierOf("crud")}";\n// insertReturning is exempt\nconst text = "insertReturning";\nother.insertReturning(1);\ntype T = typeof insertReturning;\n${badCall("insertReturning")}`;
  assert.deepEqual(withFiles({}, called), UNSCOPED);
});

test("a default export and a default import are followed, through a barrel and from the helper module", () => {
  const viaLocal = { index: 'import { insertReturning } from "./crud.js";\nexport default insertReturning;\n' };
  assert.deepEqual(found(viaLocal, `import put from "${specifierOf("index")}";\n${badCall("put")}`), UNSCOPED);
  const viaFrom = { index: 'export { insertReturning as default } from "./crud.js";\n' };
  assert.deepEqual(found(viaFrom, `import put from "${specifierOf("index")}";\n${badCall("put")}`), UNSCOPED);
  assert.deepEqual(found(viaFrom, `import { default as put } from "${specifierOf("index")}";\n${badCall("put")}`), UNSCOPED);
  assert.deepEqual(found(viaFrom, `import put, { other } from "${specifierOf("index")}";\n${badCall("put")}`), UNSCOPED);
  const own = { crud: "export function insertReturning() {}\nexport default insertReturning;\n" };
  assert.deepEqual(found(own, `import put from "${specifierOf("crud")}";\n${badCall("put")}`), UNSCOPED);
  assert.equal(found(own, `import put, * as crud from "${specifierOf("crud")}";\n${badCall("put")}\n${badCall("crud.insertReturning")}`).length, 2);
});

test("a star export does not carry a default", () => {
  const modules = { crud: "export function insertReturning() {}\nexport default insertReturning;\n", index: 'export * from "./crud.js";\n' };
  assert.deepEqual(found(modules, `import put from "${specifierOf("index")}";\n${badCall("put")}`), []);
});

test("an unmapped alias in an export star makes the barrel opaque, so a rename through it fails", () => {
  const modules = {
    b1: 'export * from "@/application/sql/crud.js";\n',
    index: 'export { insertReturning as put } from "./b1.js";\n',
  };
  assert.deepEqual(found(modules, `import { put } from "${specifierOf("index")}";\n${badCall("put")}`), UNRESOLVED);
  assert.deepEqual(found(modules, `import { put } from "${specifierOf("index")}";\n${badCall("put")}`, { aliases }), UNSCOPED);
});

test("an export star from a local-looking specifier that resolves to nothing is opaque, and a package is not", () => {
  for (const specifier of ["@/x/y.js", "~/x/y.js", "#internal/y", "../../../outside/y.js"]) {
    const modules = { index: `export * from "${specifier}";\n` };
    assert.deepEqual(found(modules, `import { anything } from "${specifierOf("index")}";\n`), UNRESOLVED, specifier);
  }
  const packages = { index: 'export * from "zod";\nexport * from "@scope/pkg";\nexport { insertReturning as put } from "./crud.js";\n' };
  assert.deepEqual(found(packages, `import { other } from "${specifierOf("index")}";\n`), []);
  assert.deepEqual(found(packages, `import { put } from "${specifierOf("index")}";\n${badCall("put")}`), UNSCOPED);
});

test("an export star from a path pattern the alias map skips is opaque too", () => {
  const skipped = aliasMap('{"compilerOptions":{"paths":{"@app/*/sql":["src/*/sql"]}}}');
  const modules = { index: 'export * from "@app/x/sql";\n' };
  assert.deepEqual(found(modules, `import { anything } from "${specifierOf("index")}";\n`, { aliases: skipped }), UNRESOLVED);
});

test("opacity travels through a re-export chain and a cycle", () => {
  const modules = {
    inner: 'export * from "@/x/y.js";\n',
    mid: 'export * from "./inner.js";\nexport * from "./index.js";\n',
    index: 'export * from "./mid.js";\n',
  };
  assert.deepEqual(found(modules, `import { anything } from "${specifierOf("index")}";\n`), UNRESOLVED);
});

test("import and export with no whitespace are read", () => {
  assert.deepEqual(withFiles({}, `import{insertReturning}from"${specifierOf("crud")}";\n${badCall("insertReturning")}`), UNSCOPED);
  const named = { index: 'export{insertReturning as put}from"./crud.js";\n' };
  assert.deepEqual(found(named, `import{put}from"${specifierOf("index")}";\n${badCall("put")}`), UNSCOPED);
  const star = { index: 'export*from"./crud.js";\n' };
  assert.deepEqual(found(star, `import{insertReturning}from"${specifierOf("index")}";\n${badCall("insertReturning")}`), UNSCOPED);
  const space = { index: 'export*as crud from"./crud.js";\n' };
  assert.deepEqual(found(space, `import*as b from"${specifierOf("index")}";\n${badCall("b.crud.insertReturning")}`), UNSCOPED);
});

test("a multi-line import and re-export list are read", () => {
  const modules = { index: 'export {\n  updateVersionedRow as upd,\n  insertReturning as put,\n} from "./crud.js";\n' };
  const caller = `import {\n  put,\n  upd,\n} from "${specifierOf("index")}";\n${badCall("put")}\nupd(tx, "b", f, id, id, 1, C);`;
  assert.deepEqual(found(modules, caller), [...UNSCOPED, ...UNSCOPED]);
});

test("what the gate does not read passes unseen: require, a dynamic import, a type import", () => {
  const modules = { index: 'export { insertReturning as put } from "./crud.js";\n' };
  const unseen = [
    `const { put } = require("${specifierOf("index")}");\n${badCall("put")}`,
    `const { put } = await import("${specifierOf("index")}");\n${badCall("put")}`,
    `import type { put } from "${specifierOf("index")}";\n${badCall("put")}`,
  ];
  for (const source of unseen) assert.deepEqual(found(modules, source), [], source);
});

/** A small deterministic generator, so a pinned count does not move. */
function random(seed) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** A strongly connected graph: a ring of stars plus random stars, the helper renamed inside it. */
function denseCycle(count, edges) {
  const next = random(45);
  const lines = Array.from({ length: count }, (_, i) => new Set([`export * from "./m${(i + 1) % count}.js";`]));
  for (let extra = count; extra < edges; extra += 1) {
    const from = Math.floor(next() * count);
    lines[from].add(`export * from "./m${Math.floor(next() * count)}.js";`);
  }
  lines[0].add('export { insertReturning as put } from "./crud.js";');
  lines[7].add('export { put as again } from "./m0.js";');
  lines[count - 1].add('export * as crud from "./crud.js";');
  return Object.fromEntries(Array.from(lines, (set, i) => [`${SQL}/m${i}.ts`, `${[...set].join("\n")}\n`]));
}

test("a dense cyclic graph of 2,000 files and 5,000 edges resolves in under 2 s, within the step budget", { timeout: 20_000 }, () => {
  const barrels = denseCycle(2000, 5000);
  const files = [
    ...Object.entries(barrels).map(([path, contents]) => ({ path, contents })),
    { path: FILE, contents: `import { put, again } from "${specifierOf("m1000")}";\nimport { crud } from "${specifierOf("m1500")}";\n${badCall("put")}\n${badCall("again")}\n${badCall("crud.insertReturning")}` },
  ];
  const before = performance.now();
  const resolution = gate.resolveHelpers(files, helpers);
  const problems = [...checkExemptHelperCalls(files, helpers), ...unresolvedHelperImports(files, helpers)];
  const elapsed = performance.now() - before;
  assert.ok(elapsed < 2000, `took ${Math.round(elapsed)} ms`);
  assert.equal(resolution.exceeded, false);
  assert.ok(resolution.steps <= 50_000, `${resolution.steps} steps`);
  assert.equal(resolution.steps, 8604, "the pinned step count moves only when the algorithm does");
  assert.deepEqual(problems.map((problem) => problem.rule), [UNSCOPED[0], UNSCOPED[0], UNSCOPED[0]]);
});

test("a resolution past the step budget fails closed with one problem that names the budget", () => {
  const barrels = denseCycle(60, 150);
  const files = [
    ...Object.entries(barrels).map(([path, contents]) => ({ path, contents })),
    { path: FILE, contents: `import { put } from "${specifierOf("m30")}";\n${badCall("put")}` },
  ];
  const problems = unresolvedHelperImports(files, helpers, { budget: 25 });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "unresolved-helper-import");
  assert.match(problems[0].detail, /budget of 25 steps/);
  assert.deepEqual(checkExemptHelperCalls(files, helpers, { budget: 25 }), []);
  assert.equal(gate.resolveHelpers(files, helpers, { budget: 25 }).exceeded, true);
  assert.deepEqual(unresolvedHelperImports(files, helpers), []);
});

test("the three checks share one resolution of a file list, so no file is parsed twice", () => {
  const files = [{ path: FILE, contents: IMPORT }];
  const options = { aliases: [] };
  assert.equal(gate.resolveHelpers(files, helpers, options), gate.resolveHelpers(files, helpers, options));
  assert.notEqual(gate.resolveHelpers(files, helpers, options), gate.resolveHelpers([...files], helpers, options));
});

/** A chain of `count` barrels with a rename at every level: r1 from index, r2 from n2, and so on down to the helper. */
function renameChain(count) {
  const modules = {};
  for (let i = 1; i <= count; i += 1) {
    const name = i === 1 ? "index" : `n${i}`;
    const next = i === count ? "crud" : `n${i + 1}`;
    modules[name] = `export { ${i === count ? "insertReturning" : `r${i + 1}`} as r${i} } from "./${next}.js";\n`;
  }
  return modules;
}

test("a rename at every level of a chain is followed, whatever the order of the importers", () => {
  for (const count of [1, 2, 8, 9, 40]) {
    assert.deepEqual(found(renameChain(count), `import { r1 } from "${specifierOf("index")}";\n${badCall("r1")}`), UNSCOPED, `${count} barrels`);
  }
  const modules = renameChain(9);
  const deep = `import { r1 } from "${specifierOf("index")}";\n${badCall("r1")}`;
  const middle = `import { r5 } from "${specifierOf("n5")}";\n${badCall("r5")}`;
  const files = (callers) => [...Object.entries(modulesAt(modules)).map(([path, contents]) => ({ path, contents })), ...callers];
  const at5 = { path: "backend/src/features/b/shared/y.ts", contents: middle };
  const at1 = { path: FILE, contents: deep };
  for (const order of [[at1, at5], [at5, at1]]) {
    assert.equal(checkExemptHelperCalls(files(order), helpers).length, 2);
    assert.deepEqual(unresolvedHelperImports(files(order), helpers), []);
  }
});

test("a diamond of stars, a namespace import of a renaming barrel, and a re-exported namespace are followed", () => {
  const diamond = {
    index: 'export * from "./l.js";\nexport * from "./r.js";\n',
    l: 'export * from "./base.js";\n',
    r: 'export * from "./base.js";\n',
    base: 'export { insertReturning as put } from "./crud.js";\n',
  };
  assert.deepEqual(found(diamond, `import { put } from "${specifierOf("index")}";\n${badCall("put")}`), UNSCOPED);
  const renaming = { index: 'export { insertReturning as put } from "./crud.js";\n' };
  assert.deepEqual(found(renaming, `import * as b from "${specifierOf("index")}";\n${badCall("b.put")}`), UNSCOPED);
  const listed = { index: 'import * as crud from "./crud.js";\nexport { crud };\n' };
  assert.deepEqual(found(listed, `import * as b from "${specifierOf("index")}";\n${badCall("b.crud.insertReturning")}`), UNSCOPED);
});

// ---- Fix round 1: a byte-order mark, comments in a list, a default function, an alias in the helper's
// module, a cap on the paths, a lexer for templates and regular expressions, an unmapped default import.

const importOf = (name, from = "crud") => `import { ${name} } from "${specifierOf(from)}";\n`;
const callsOf = (name) => `${importOf(name)}${badCall(name)}`;

test("a leading byte-order mark does not hide the first import", () => {
  assert.deepEqual(withFiles({}, `\uFEFF${callsOf("insertReturning")}`), UNSCOPED);
  const barrel = { index: '\uFEFFexport { insertReturning as put } from "./crud.js";\n' };
  assert.deepEqual(found(barrel, `\uFEFFimport { put } from "${specifierOf("index")}";\n${badCall("put")}`), UNSCOPED);
});

test("a comment inside an import or export list does not stop the read", () => {
  const list = (body) => `import {\n${body}\n} from "${specifierOf("crud")}";\n${badCall("insertReturning")}`;
  const bodies = [
    " // c\n  insertReturning,",
    "  insertReturning /* h */,\n  other,",
    "  other, // don't\n  insertReturning,",
    "  other, // a; b\n  insertReturning,",
    "  /* it's; here */ insertReturning,",
  ];
  for (const body of bodies) assert.deepEqual(withFiles({}, list(body)), UNSCOPED, body);
  const barrel = { index: 'export {\n  // eslint-disable-next-line\n  insertReturning as put,\n} from "./crud.js";\n' };
  assert.deepEqual(found(barrel, `import { put } from "${specifierOf("index")}";\n${badCall("put")}`), UNSCOPED);
  const quoted = { index: 'export {\n  // it\'s; a "quote"\n  insertReturning as put,\n} from "./crud.js";\n' };
  assert.deepEqual(found(quoted, `import { put } from "${specifierOf("index")}";\n${badCall("put")}`), UNSCOPED);
});

test("a commented-out import or export is still not read", () => {
  const barrel = { index: '// export { insertReturning as put } from "./crud.js";\n/* export { insertReturning as put } from "./crud.js"; */\n' };
  assert.deepEqual(found(barrel, `import { put } from "${specifierOf("index")}";\n${badCall("put")}`), []);
});

test("a default export of the helper's own function is followed, and so is the async form", () => {
  for (const declaration of ["export default function insertReturning() {}", "export default async function insertReturning<T>(a: T) {}"]) {
    const own = { crud: `${declaration}\n` };
    assert.deepEqual(found(own, `import put from "${specifierOf("crud")}";\n${badCall("put")}`), UNSCOPED, declaration);
    const barrel = { ...own, index: 'export { default as put } from "./crud.js";\nexport { default } from "./crud.js";\n' };
    assert.deepEqual(found(barrel, `import { put } from "${specifierOf("index")}";\n${badCall("put")}`), UNSCOPED, declaration);
  }
  const other = { crud: "export default function somethingElse() {}\nexport function insertReturning() {}\n" };
  assert.deepEqual(found(other, `import put from "${specifierOf("crud")}";\n${badCall("put")}`), []);
});

test("a local alias in the helper's own module is followed, and any other use of the helper there is opaque", () => {
  const alias = { crud: "export function insertReturning() {}\nconst alias = insertReturning;\nexport { alias as put };\n" };
  assert.deepEqual(found(alias, callsOf("put")), UNSCOPED);
  const chained = { crud: "export function insertReturning() {}\nconst a = insertReturning;\nlet b = a;\nexport { b as put };\n" };
  assert.deepEqual(found(chained, callsOf("put")), UNSCOPED);
  const wrapped = { crud: "export function insertReturning() {}\nconst safe = wrap(insertReturning);\nexport { safe as put };\n" };
  assert.deepEqual(found(wrapped, callsOf("put")).slice(-1), UNRESOLVED);
  const plain = { crud: "export function insertReturning() { return insertReturning(); }\nexport const other = 1;\n" };
  assert.deepEqual(found(plain, callsOf("insertReturning")), UNSCOPED);
  const declared = { crud: "export const insertReturning = async () => {};\nexport const other = 1;\n" };
  assert.deepEqual(found(declared, callsOf("insertReturning")), UNSCOPED);
});

test("the paths kept per module are capped, so self-aliasing namespaces cannot blow up the work", { timeout: 20_000 }, () => {
  const K = 14;
  const self = Array.from({ length: K }, (_, i) => `export * as a${i} from "./M.js";`).join("\n");
  const modules = { M: `export { insertReturning as put } from "./crud.js";\n${self}\n` };
  const files = [
    ...Object.entries(modulesAt(modules)).map(([path, contents]) => ({ path, contents })),
    ...Array.from({ length: 20 }, (_, i) => ({ path: `backend/src/features/f${i}/shared/q.ts`, contents: `import { put } from "${specifierOf("M")}";\n${badCall("put")}` })),
  ];
  const before = performance.now();
  const rules = unresolvedHelperImports(files, helpers).map((problem) => problem.rule);
  const elapsed = performance.now() - before;
  assert.ok(elapsed < 1000, `took ${Math.round(elapsed)} ms`);
  const { widest } = gate.resolveHelpers(files, helpers);
  assert.ok(widest <= 64, `${widest} paths in one summary`);
  assert.equal(rules.length, 20);
  assert.ok(rules.every((rule) => rule === UNRESOLVED[0]));
});

test("a quote inside a template or a regular expression does not hide a later alias", () => {
  const head = `import { insertReturning } from "${specifierOf("crud")}";\n`;
  const shapes = [
    "const a = `x ' y`; const f = insertReturning; const b = 'z';",
    'const a = `x " y`; const f = insertReturning; const b = "z";',
    "const re = /'/; const f = insertReturning; const g = '';",
    "const re = /[\"']/g; const f = insertReturning; const g = '';",
    "const a = `${b}'`; const f = insertReturning; const g = '';",
    "const a = `${`'`}`; const f = insertReturning; const g = '';",
    "const a = x / 2; const f = insertReturning; const g = y / 3;",
  ];
  for (const shape of shapes) assert.deepEqual(withFiles({}, `${head}${shape}\n${badCall("f")}`), UNRESOLVED, shape);
});

test("text inside a template or a regular expression is not a use, but an expression inside a template is", () => {
  const head = `import { insertReturning } from "${specifierOf("crud")}";\n`;
  const text = "const a = `call insertReturning here`;\nconst re = /insertReturning/;\nconst b = x / 2; const c = y / 3;\n";
  assert.deepEqual(withFiles({}, `${head}${text}${badCall("insertReturning")}`), UNSCOPED);
  const inside = "const s = `${wrap(insertReturning)}`;\n";
  assert.deepEqual(withFiles({}, `${head}${inside}${badCall("insertReturning")}`), [...UNSCOPED, ...UNRESOLVED]);
});

const rulesOf = (problems) => problems.map((problem) => problem.rule);

test("a default import from an unmapped local alias fails closed, as the named import does", () => {
  assert.deepEqual(rulesOf(both('import put from "@/application/sql/crud";\nput(tx, "a", ["id"], v, C, f);\n')), UNRESOLVED);
  assert.deepEqual(rulesOf(both('import put from "~/sql/crud";\n')), UNRESOLVED);
  assert.deepEqual(rulesOf(both('import z from "zod";\nimport data from "./data.json";\n')), []);
  assert.deepEqual(rulesOf(both('import put from "@/application/sql/crud.js";\n', { aliases })), []);
});

test("what the gate still does not read passes unseen: an import-equals require, and a regular expression after a bracket", () => {
  const modules = { index: 'export { insertReturning as put } from "./crud.js";\n' };
  assert.deepEqual(found(modules, `import put = require("${specifierOf("index")}");\n${badCall("put")}`), []);
  const head = `import { insertReturning } from "${specifierOf("crud")}";\n`;
  assert.deepEqual(withFiles({}, `${head}if (x) /'/.test(y); const f = insertReturning; const g = '';\n${badCall("f")}`), []);
});

test("a regular expression after an arrow is read as one, so a backtick in it hides nothing", () => {
  const head = `import { insertReturning } from "${specifierOf("crud")}";\n`;
  const shape = "xs.filter((s) => /`/.test(s)); const f = insertReturning;";
  assert.deepEqual(withFiles({}, `${head}${shape}\n${badCall("f")}`), UNRESOLVED);
});
