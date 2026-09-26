import test from "node:test";
import assert from "node:assert/strict";
import { checkMigrationNumbers } from "./migration-numbers.mjs";

const DIR = "backend/src/drizzle";

test("contiguous prefixes pass, and a name that is not a migration is ignored", () => {
  const names = ["0001_identity.sql", "0002_projects.sql", "0003_sites.sql", "meta", "README.md"];
  assert.deepEqual(checkMigrationNumbers(names, DIR), []);
});

test("the numbers may start above one, as after a squash", () => {
  assert.deepEqual(checkMigrationNumbers(["0040_base.sql", "0041_photos.sql"], DIR), []);
});

test("a duplicate prefix fails and names both files", () => {
  const problems = checkMigrationNumbers(["0001_identity.sql", "0002_projects.sql", "0002_sites.sql"], DIR);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "duplicate-migration-number");
  assert.equal(problems[0].path, DIR);
  assert.match(problems[0].detail, /0002_projects\.sql/);
  assert.match(problems[0].detail, /0002_sites\.sql/);
});

test("a gap fails and names the missing numbers", () => {
  const problems = checkMigrationNumbers(["0001_identity.sql", "0002_projects.sql", "0005_sites.sql"], DIR);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "migration-number-gap");
  assert.match(problems[0].detail, /\b3\b.*\b4\b/);
});

test("a different width is the same number", () => {
  const problems = checkMigrationNumbers(["0001_identity.sql", "01_projects.sql"], DIR);
  assert.equal(problems[0].rule, "duplicate-migration-number");
});
