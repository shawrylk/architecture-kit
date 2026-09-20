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
});

test("the table name comes from options", () => {
  const problems = checkAuditAppendOnly(resource("delete from trail where id = $1"), { table: "trail" });
  assert.equal(problems.length, 1);
});
