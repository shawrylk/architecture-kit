import test from "node:test";
import assert from "node:assert/strict";
import { checkAuditAppendOnly } from "./audit-append-only.mjs";

const resource = (sql) => [{ path: "a/resource.ts", statements: [{ sql }] }];

test("an insert into the audit log is the point, and passes", () => {
  assert.deepEqual(checkAuditAppendOnly(resource("insert into audit_log (id) values ($1)")), []);
});

test("a select from the audit log passes", () => {
  assert.deepEqual(checkAuditAppendOnly(resource("select * from audit_log where tenant_id = $1")), []);
});

test("an update fails", () => {
  const problems = checkAuditAppendOnly(resource("update audit_log set actor = $1"));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "audit-mutated");
});

test("a delete fails", () => {
  assert.equal(checkAuditAppendOnly(resource("delete from audit_log where id = $1")).length, 1);
});

test("a truncate fails", () => {
  assert.equal(checkAuditAppendOnly(resource("truncate table audit_log")).length, 1);
});

test("another table of a similar name is not the audit log", () => {
  assert.deepEqual(checkAuditAppendOnly(resource("delete from audit_log_archive where id = $1")), []);
  assert.deepEqual(checkAuditAppendOnly(resource('update "audit_logs" set actor = $1')), []);
});

test("a quoted, schema-qualified or only name, a list truncate, a merge and an upsert fail", () => {
  for (const sql of [
    "update public.audit_log set actor = $1",
    'delete from "audit_log" where id = $1',
    'update "public"."audit_log" set actor = $1',
    "update only audit_log set actor = $1",
    "truncate sessions, audit_log",
    "merge into audit_log using x on true when matched then update set actor = x.actor",
    "insert into audit_log (id, actor) values ($1, $2) on conflict (id) do update set actor = excluded.actor",
  ]) {
    assert.equal(checkAuditAppendOnly(resource(sql)).length, 1, sql);
  }
});

test("an insert that does nothing on conflict changes no row, and passes", () => {
  assert.deepEqual(checkAuditAppendOnly(resource("insert into audit_log (id) values ($1) on conflict (id) do nothing")), []);
});

test("the table name comes from options", () => {
  const problems = checkAuditAppendOnly(resource("delete from trail where id = $1"), { table: "trail" });
  assert.equal(problems.length, 1);
});
