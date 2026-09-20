import test from "node:test";
import assert from "node:assert/strict";
import { policyStatements, tenantScopedTables } from "./tenant-tables.mjs";

const slice = `
export const tenants = pgTable("tenants", {
  tenantId: "tenant_id",
  name: "name",
});

export const memberships = pgTable("memberships", {
  tenantId: "tenant_id",
  userId: "user_id",
});
`;

test("a tenant-scoped table is listed", () => {
  assert.deepEqual(tenantScopedTables(slice), ["memberships", "tenants"]);
});

test("a table with no tenant column is not listed", () => {
  const source = `export const rates = pgTable("exchange_rates", { code: "code" });`;
  assert.deepEqual(tenantScopedTables(source), []);
});

test("a nested object inside a column definition does not end the table early", () => {
  const source = `export const photos = pgTable("photos", {
    id: uuid("id").default({ mode: "random" }),
    tenantId: uuid("tenant_id"),
  });`;
  assert.deepEqual(tenantScopedTables(source), ["photos"]);
});

test("a source with no table yields nothing", () => {
  assert.deepEqual(tenantScopedTables("export const queries = {};"), []);
});

test("every policy forces row level security, so the owning role is filtered too", () => {
  const sql = policyStatements("photos");
  assert.match(sql, /force row level security/);
  assert.match(sql, /drop policy if exists photos_isolation/);
  assert.match(sql, /with check \(tenant_id = current_setting\('app\.tenant_id'\)::uuid\)/);
});

test("the table factory, tenant column and policy setting come from options", () => {
  const source = 'export const pins = table("pins", { orgId: uuid(), name: text() });';
  const found = tenantScopedTables(source, { tableFactory: "table", column: "orgId" });
  assert.deepEqual(found, ["pins"]);
  const policy = policyStatements("pins", { sqlColumn: "org_id", setting: "app.org", cast: "text" });
  assert.ok(policy.includes("org_id = current_setting('app.org')::text"));
});

test("a table carrying a different column than the configured one is not listed", () => {
  const source = 'export const pins = table("pins", { tenantId: uuid() });';
  assert.deepEqual(tenantScopedTables(source, { tableFactory: "table", column: "orgId" }), []);
});
