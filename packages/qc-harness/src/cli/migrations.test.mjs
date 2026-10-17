import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { planRenumber, renumber } from "./migrations.mjs";

const QC = fileURLToPath(new URL("./qc.mjs", import.meta.url));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

function repo(t) {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-migrations-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q", "-b", "main");
  for (const [key, value] of [["user.name", "qc"], ["user.email", "qc@example.com"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) git(dir, "config", key, value);
  commitFile(dir, "db/0001_init.sql", "select 1;\n");
  return dir;
}

function commitFile(dir, file, text) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", file);
}

test("the plan puts the added migrations after the last one, in number order", () => {
  assert.deepEqual(planRenumber(["0001_a.sql", "0002_b.sql"], ["0003_y.sql", "0002_x.sql"]), [
    { from: "0002_x.sql", to: "0003_x.sql" },
    { from: "0003_y.sql", to: "0004_y.sql" },
  ]);
});

test("a migration already in place is left alone, and a name that is no migration is ignored", () => {
  assert.deepEqual(planRenumber(["0001_a.sql"], ["0002_x.sql", "meta.json"]), []);
});

test("the plan keeps the width of the existing numbers", () => {
  assert.deepEqual(planRenumber(["000009_a.sql"], ["000009_x.sql"]), [{ from: "000009_x.sql", to: "000010_x.sql" }]);
});

test("renumber moves the branch's migrations after the base's last, rewrites references, and a second run changes nothing", (t) => {
  const dir = repo(t);
  git(dir, "switch", "-q", "-c", "feat/1-x");
  commitFile(dir, "db/0002_x.sql", "select 2;\n");
  commitFile(dir, "db/meta.json", '{"tag":"0002_x"}\n');
  git(dir, "switch", "-q", "main");
  commitFile(dir, "db/0002_main.sql", "select 3;\n");
  git(dir, "switch", "-q", "feat/1-x");
  git(dir, "merge", "-q", "--no-edit", "main");
  const first = renumber(dir, "db", { onto: "main" });
  assert.deepEqual(first.plan, [{ from: "0002_x.sql", to: "0003_x.sql" }]);
  assert.deepEqual(readdirSync(path.join(dir, "db")).sort(), ["0001_init.sql", "0002_main.sql", "0003_x.sql", "meta.json"]);
  assert.equal(readFileSync(path.join(dir, "db", "meta.json"), "utf8"), '{"tag":"0003_x"}\n');
  git(dir, "commit", "-q", "-m", "renumber");
  assert.deepEqual(renumber(dir, "db", { onto: "main" }).plan, []);
});

test("qc migrations with no subcommand prints its usage and exits 2", (t) => {
  const dir = repo(t);
  const result = spawnSync(process.execPath, [QC, "migrations"], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /qc migrations renumber --onto <ref>/);
});

test("renumber refuses a dirty tree outside a merge", (t) => {
  const dir = repo(t);
  git(dir, "switch", "-q", "-c", "feat/1-x");
  commitFile(dir, "db/0002_x.sql", "select 2;\n");
  writeFileSync(path.join(dir, "stray.txt"), "uncommitted\n");
  assert.throws(() => renumber(dir, "db", { onto: "main" }), /uncommitted|clean/);
});

test("a stem is rewritten only where no name character follows it", () => {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-migrations-stem-")));
  try {
    git(dir, "init", "-q", "-b", "main");
    for (const [key, value] of [["user.name", "qc"], ["user.email", "qc@example.com"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) git(dir, "config", key, value);
    commitFile(dir, "db/0001_init.sql", "select 1;\n");
    git(dir, "switch", "-q", "-c", "feat/1-x");
    commitFile(dir, "db/0002_add.sql", "select 2;\n");
    commitFile(dir, "refs.txt", "0002_add 0002_add_index\n");
    git(dir, "switch", "-q", "main");
    commitFile(dir, "db/0002_main.sql", "select 3;\n");
    git(dir, "switch", "-q", "feat/1-x");
    git(dir, "merge", "-q", "--no-edit", "main");
    renumber(dir, "db", { onto: "main" });
    assert.equal(readFileSync(path.join(dir, "refs.txt"), "utf8"), "0003_add 0002_add_index\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
