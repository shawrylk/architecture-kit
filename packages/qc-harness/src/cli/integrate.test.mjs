import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { integrationBranch, runIntegrate } from "./integrate.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const quiet = (lines) => (line) => lines.push(line);
const run = (command, cwd) => spawnSync(command, { cwd, shell: true, stdio: "pipe" }).status ?? 1;

function commitFile(dir, file, text) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", file);
}

/** A repository on main with one migration and a generator, and two branches that each add a migration. */
function batch(t) {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-integrate-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q", "-b", "main");
  for (const [key, value] of [["user.name", "qc"], ["user.email", "qc@example.com"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) git(dir, "config", key, value);
  commitFile(dir, "db/0001_init.sql", "select 1;\n");
  commitFile(dir, "gen.mjs", 'import { writeFileSync } from "node:fs";\nwriteFileSync("out.generated.txt", "regenerated\\n");\n');
  commitFile(dir, "a.txt", "base\n");
  for (const name of ["a", "b"]) {
    git(dir, "switch", "-q", "-c", `feat/${name === "a" ? 1 : 2}-${name}`, "main");
    commitFile(dir, `db/0002_${name}.sql`, `select '${name}';\n`);
  }
  git(dir, "switch", "-q", "main");
  return dir;
}

function batchWithOrigin(t) {
  const dir = batch(t);
  const origin = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-integrate-origin-")));
  t.after(() => rmSync(origin, { recursive: true, force: true }));
  git(origin, "init", "-q", "--bare");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "switch", "-q", "-c", "feat/3-c", "main");
  commitFile(dir, "db/0002_c.sql", "select 'c';\n");
  git(dir, "switch", "-q", "main");
  return dir;
}

const config = (dir, command = "node gen.mjs") => ({
  root: dir,
  paths: { migrations: "db" },
  generated: { globs: ["**/*.generated.*"], command },
  branches: { pattern: "^[a-z]+/[0-9]+-" },
  worktree: { base: "main" },
});

test("the integration branch names its issue, and an issue that is no number is refused", () => {
  assert.equal(integrationBranch({ issue: "7" }), "feat/7-integration");
  assert.equal(integrationBranch({ issue: "7", type: "fix", slug: "Desktop Round" }), "fix/7-desktop-round");
  assert.throws(() => integrationBranch({ issue: "x" }), /issue number/);
});

test("integrate merges each branch in order and renumbers the later branch's migration", async (t) => {
  const dir = batch(t);
  const said = [];
  const code = await runIntegrate(config(dir), ["--issue", "7", "--from", "main", "feat/1-a", "feat/2-b"], { say: quiet(said), run });
  assert.equal(code, 0, said.join("\n"));
  assert.equal(git(dir, "branch", "--show-current"), "feat/7-integration");
  assert.deepEqual(readdirSync(path.join(dir, "db")).sort(), ["0001_init.sql", "0002_a.sql", "0003_b.sql"]);
  assert.equal(readFileSync(path.join(dir, "out.generated.txt"), "utf8"), "regenerated\n");
  assert.equal(git(dir, "status", "--porcelain"), "");
  assert.equal(said.filter((line) => line.startsWith("push")).length, 0);
});

test("integrate pushes every two merges and pushes the remaining merge", async (t) => {
  const dir = batchWithOrigin(t);
  const said = [];
  const settings = { ...config(dir), integrate: { ciEvery: 2 } };
  const argv = ["--issue", "7", "--from", "main", "feat/1-a", "feat/2-b", "feat/3-c"];
  assert.equal(await runIntegrate(settings, argv, { say: quiet(said), run }), 0, said.join("\n"));
  assert.equal(said.filter((line) => line.startsWith("push")).length, 2);
  assert.equal(git(dir, "ls-remote", "origin", "refs/heads/feat/7-integration").split(/\s+/)[0], git(dir, "rev-parse", "HEAD"));
  assert.ok(!said.find((line) => line.startsWith("OK")).includes("Push it:"));
});

test("integrate pushes once for three merges at a cadence of three", async (t) => {
  const dir = batchWithOrigin(t);
  const said = [];
  const settings = { ...config(dir), integrate: { ciEvery: 3 } };
  assert.equal(await runIntegrate(settings, ["--issue", "7", "--from", "main", "feat/1-a", "feat/2-b", "feat/3-c"], { say: quiet(said), run }), 0, said.join("\n"));
  assert.equal(said.filter((line) => line.startsWith("push")).length, 1);
});

test("integrate can disable pushes and shows the manual push command", async (t) => {
  const dir = batchWithOrigin(t);
  const said = [];
  const settings = { ...config(dir), integrate: { push: false } };
  assert.equal(await runIntegrate(settings, ["--issue", "7", "--from", "main", "feat/1-a", "feat/2-b", "feat/3-c"], { say: quiet(said), run }), 0, said.join("\n"));
  assert.equal(said.filter((line) => line.startsWith("push")).length, 0);
  assert.match(said.find((line) => line.startsWith("OK")), /Push it: git push -u origin feat\/7-integration$/);
  assert.equal(git(dir, "ls-remote", "origin", "refs/heads/feat/7-integration"), "");
});

test("integrate skips pushes on a second run with nothing new", async (t) => {
  const dir = batchWithOrigin(t);
  const settings = config(dir);
  const argv = ["--issue", "7", "--from", "main", "feat/1-a", "feat/2-b", "feat/3-c"];
  const first = [];
  assert.equal(await runIntegrate(settings, argv, { say: quiet(first), run }), 0, first.join("\n"));
  assert.equal(first.filter((line) => line.startsWith("push")).length, 1);
  const said = [];
  assert.equal(await runIntegrate(settings, argv, { say: quiet(said), run }), 0, said.join("\n"));
  assert.equal(said.filter((line) => line.startsWith("push")).length, 0);
});

test("a failed push reports git push and keeps the local merges", async (t) => {
  const dir = batchWithOrigin(t);
  git(dir, "remote", "set-url", "origin", path.join(dir, "missing-origin.git"));
  const said = [];
  const errors = [];
  t.mock.method(console, "error", quiet(errors));
  assert.equal(await runIntegrate(config(dir), ["--issue", "7", "--from", "main", "feat/1-a", "feat/2-b", "feat/3-c"], { say: quiet(said), run }), 1);
  assert.match(errors.join("\n"), /git push/);
  assert.equal(git(dir, "branch", "--show-current"), "feat/7-integration");
  for (const branch of ["feat/1-a", "feat/2-b", "feat/3-c"]) git(dir, "merge-base", "--is-ancestor", branch, "HEAD");
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("a conflict stops the run with the file list, and a second run after the resolution continues", async (t) => {
  const dir = batch(t);
  for (const branch of ["feat/1-a", "feat/2-b"]) {
    git(dir, "switch", "-q", branch);
    commitFile(dir, "a.txt", `${branch}\n`);
  }
  git(dir, "switch", "-q", "main");
  const said = [];
  assert.equal(await runIntegrate(config(dir, null), ["--issue", "7", "--from", "main", "feat/1-a", "feat/2-b"], { say: quiet(said), run }), 1);
  const report = said.join("\n");
  assert.match(report, /a\.txt/);
  assert.match(report, /qc migrations renumber --onto HEAD --branch MERGE_HEAD/);
  assert.ok(existsSync(path.join(dir, ".git", "MERGE_HEAD")));
  writeFileSync(path.join(dir, "a.txt"), "both\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "--no-edit");
  const again = [];
  assert.equal(await runIntegrate(config(dir, null), ["--issue", "7", "--from", "main", "feat/1-a", "feat/2-b"], { say: quiet(again), run }), 0);
  assert.equal(again.filter((line) => line.startsWith("skip")).length, 2);
});

test("a conflict only in generated files is settled by the generator", async (t) => {
  const dir = batch(t);
  for (const branch of ["feat/1-a", "feat/2-b"]) {
    git(dir, "switch", "-q", branch);
    commitFile(dir, "out.generated.txt", `${branch}\n`);
  }
  git(dir, "switch", "-q", "main");
  const said = [];
  assert.equal(await runIntegrate(config(dir), ["--issue", "7", "--from", "main", "feat/1-a", "feat/2-b"], { say: quiet(said), run }), 0, said.join("\n"));
  assert.equal(readFileSync(path.join(dir, "out.generated.txt"), "utf8"), "regenerated\n");
  assert.equal(git(dir, "status", "--porcelain"), "");
});
