import test from "node:test";
import assert from "node:assert/strict";
import { checkSqlIdentifiers, declaredColumns, tableOwners, usedIdentifiers } from "./sql-identifiers.mjs";

const ddl = `
create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  code text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
`;

test("columns are read out of a create table, and a constraint line is not one", () => {
  const tables = declaredColumns([ddl]);
  assert.deepEqual([...tables.get("projects")].sort(), ["code", "created_at", "id", "tenant_id"]);
});

test("a later expand migration adds its column to the same table", () => {
  const tables = declaredColumns([ddl, "alter table projects add column archived_at timestamptz;"]);
  assert.ok(tables.get("projects").has("archived_at"));
});

const resource = (sql) => `const SQL = \`${sql}\`;`;

test("an agreeing slice has no finding", () => {
  const tables = declaredColumns([ddl]);
  const source = resource("select id, tenant_id, code from projects where tenant_id = $1");
  assert.deepEqual(checkSqlIdentifiers(tables, [{ path: "r.ts", source }]), []);
});

test("a column no migration declares is named", () => {
  const tables = declaredColumns([ddl]);
  const source = resource("select id, project_code from projects where tenant_id = $1");
  const problems = checkSqlIdentifiers(tables, [{ path: "r.ts", source }]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].detail, /'project_code'/);
});

test("a table no migration declares is named", () => {
  const tables = declaredColumns([ddl]);
  const source = resource("select id from project_tags where tenant_id = $1");
  const problems = checkSqlIdentifiers(tables, [{ path: "r.ts", source }]);
  assert.deepEqual(problems.map((problem) => problem.rule), ["undeclared-sql-identifier"]);
});

test("a value in quotes is not mistaken for a column", () => {
  const tables = declaredColumns([ddl]);
  const source = resource("select id from projects where tenant_id = $1 and code = 'site_admin'");
  assert.deepEqual(checkSqlIdentifiers(tables, [{ path: "r.ts", source }]), []);
});

test("an output alias in double quotes is not mistaken for a column", () => {
  const tables = declaredColumns([ddl]);
  const source = resource(`select tenant_id as "tenantId" from projects where tenant_id = $1`);
  assert.deepEqual(checkSqlIdentifiers(tables, [{ path: "r.ts", source }]), []);
});

test("an index the slice declares itself is known", () => {
  const source = `const i = index("projects_tenant_created_idx").on(a, b);
const SQL = \`select id from projects where tenant_id = $1\`;`;
  assert.ok(usedIdentifiers(source).declaredIndexes.has("projects_tenant_created_idx"));
});

test("a template literal that is not a statement is ignored", () => {
  const tables = declaredColumns([ddl]);
  const source = "const key = `blueprints/${tenantId}/${blueprint_id}`;";
  assert.deepEqual(checkSqlIdentifiers(tables, [{ path: "r.ts", source }]), []);
});

test("a common table expression names itself and is not a missing table", () => {
  const tables = declaredColumns([ddl]);
  const source = resource(
    "with settled_rows as (select id from projects where tenant_id = $1) select id from settled_rows",
  );
  assert.deepEqual(checkSqlIdentifiers(tables, [{ path: "r.ts", source }]), []);
});

test("a second common table expression in the same statement is bound too", () => {
  const tables = declaredColumns([ddl]);
  const source = resource(
    "with first_pass as (select id from projects), second_pass as (select id from first_pass) select id from second_pass",
  );
  assert.deepEqual(checkSqlIdentifiers(tables, [{ path: "r.ts", source }]), []);
});

test("a snake_case table alias is bound by its own statement", () => {
  const tables = declaredColumns([ddl]);
  const source = resource("select live_projects.id from projects as live_projects where live_projects.tenant_id = $1");
  assert.deepEqual(checkSqlIdentifiers(tables, [{ path: "r.ts", source }]), []);
});

test("a binding does not hide a genuine typo elsewhere", () => {
  const tables = declaredColumns([ddl]);
  const source = resource("with rows_now as (select id from projects) select project_code from rows_now");
  const problems = checkSqlIdentifiers(tables, [{ path: "r.ts", source }]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].detail, /'project_code'/);
});

test("a column type the gate has never heard of is still a column", () => {
  const tables = declaredColumns([
    `create table if not exists pins (
  id uuid primary key,
  tenant_id uuid not null,
  fx real not null,
  fy double precision not null,
  label varchar(120),
  shape geometry_kind not null,
  tags text[] not null default '{}',
  check (fx >= 0)
);`,
  ]);
  const columns = tables.get("pins");
  for (const column of ["fx", "fy", "label", "shape", "tags"]) {
    assert.ok(columns.has(column), `${column} should be a column`);
  }
});

test("a constraint line is never mistaken for a column", () => {
  const tables = declaredColumns([
    `create table if not exists a (
  id uuid primary key,
  primary key (id),
  unique (id),
  constraint a_ck check (id is not null),
  foreign key (id) references b (id)
);`,
  ]);
  assert.deepEqual([...tables.get("a")], ["id"]);
});

test("a feature reading its own table is fine", () => {
  const migrations = [{ file: "0002_projects.sql", sql: ddl }];
  const owners = tableOwners(migrations);
  const source = resource("select id from projects where tenant_id = $1");
  const problems = checkSqlIdentifiers(declaredColumns([ddl]), [{ path: "r.ts", source, feature: "projects" }], owners);
  assert.deepEqual(problems, []);
});

test("a feature reading another feature's table is named, with its owner", () => {
  const migrations = [{ file: "0002_projects.sql", sql: ddl }];
  const owners = tableOwners(migrations);
  const source = resource("select id from projects where tenant_id = $1");
  const problems = checkSqlIdentifiers(declaredColumns([ddl]), [{ path: "r.ts", source, feature: "pins" }], owners);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "cross-feature-table");
  assert.match(problems[0].detail, /belongs to feature 'projects'/);
});

test("a migration filename with an underscore names a hyphenated feature", () => {
  const owners = tableOwners([{ file: "0001_identity_tenancy.sql", sql: ddl }]);
  assert.equal(owners.get("projects"), "identity-tenancy");
});

test("a recursive common table expression binds its own name", () => {
  const tables = declaredColumns([ddl]);
  const source = resource(
    "with recursive descendants as (select id from projects where tenant_id = $1) select id from descendants",
  );
  assert.deepEqual(checkSqlIdentifiers(tables, [{ path: "r.ts", source }]), []);
});

test("an upsert's `do update set` names no table", () => {
  const tables = declaredColumns([ddl]);
  const source = resource(
    "insert into projects (id, tenant_id) values ($1, $2) on conflict (id) do update set code = $3",
  );
  assert.deepEqual(checkSqlIdentifiers(tables, [{ path: "r.ts", source }]), []);
});

test("a single-word table no migration declares is still caught", () => {
  const tables = declaredColumns([ddl]);
  const source = resource("select id from drawings where tenant_id = $1");
  const problems = checkSqlIdentifiers(tables, [{ path: "r.ts", source }]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].detail, /'drawings'/);
});

test("a feature may own a second migration with a descriptive suffix", () => {
  const owners = tableOwners(
    [{ file: "0006_blueprints_render_pages.sql", sql: ddl }],
    ["blueprints", "pins", "projects"],
  );
  assert.equal(owners.get("projects"), "blueprints");
});

test("the longest matching feature name wins, so a prefix does not steal a migration", () => {
  const owners = tableOwners([{ file: "0009_photo_ledger.sql", sql: ddl }], ["photo", "photo-ledger"]);
  assert.equal(owners.get("projects"), "photo-ledger");
});

test("a slug matching no feature keeps its own name, so an unowned table is still attributed", () => {
  const owners = tableOwners([{ file: "0010_orphan.sql", sql: ddl }], ["blueprints"]);
  assert.equal(owners.get("projects"), "orphan");
});
