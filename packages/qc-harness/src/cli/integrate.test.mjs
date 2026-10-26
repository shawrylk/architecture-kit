import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { integrationBranch, runIntegrate, USAGE } from "./integrate.mjs";

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

function pullRequestIo(dir, { view = null, create = "  https://github.com/example/repo/pull/9\n" } = {}) {
  const events = [];
  return {
    events,
    say: quiet(events),
    run,
    gh(args, { cwd }) {
      assert.equal(cwd, dir);
      events.push(args);
      return args[1] === "view" ? view : create;
    },
  };
}

const pullRequestCalls = [
  ["pr", "view", "feat/7-integration", "--json", "number"],
  ["pr", "create", "--draft", "--head", "feat/7-integration", "--base", "main", "--title", "feat: integrate the batch for #7", "--body", "Refs #7"],
];

test("integrate usage states the effective author rule", () => {
  assert.match(USAGE, /refuses.*branch.*author email.*effective Git author email/i);
});

function authorEnvironment(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

for (const setting of ["different", "absent local"]) {
  test(`integrate uses GIT_AUTHOR_EMAIL with ${setting} user.email`, async (t) => {
    const dir = batch(t);
    if (setting === "different") git(dir, "config", "user.email", "other@example.com");
    else git(dir, "config", "--unset", "user.email");
    authorEnvironment(t, {
      GIT_AUTHOR_NAME: "qc",
      GIT_AUTHOR_EMAIL: "qc@example.com",
      GIT_COMMITTER_NAME: "qc",
      GIT_COMMITTER_EMAIL: "qc@example.com",
    });
    const errors = [];
    t.mock.method(console, "error", quiet(errors));
    assert.equal(await runIntegrate(config(dir, null), ["--issue", "7", "feat/1-a"], { say: () => {}, run }), 0, errors.join("\n"));
    git(dir, "merge-base", "--is-ancestor", "feat/1-a", "HEAD");
  });
}

test("integrate rejects a branch whose authors differ from GIT_AUTHOR_EMAIL", async (t) => {
  const dir = batch(t);
  authorEnvironment(t, { GIT_AUTHOR_NAME: "other", GIT_AUTHOR_EMAIL: "other@example.com" });
  const errors = [];
  t.mock.method(console, "error", quiet(errors));
  assert.equal(await runIntegrate(config(dir, null), ["--issue", "7", "feat/1-a"], { say: () => {}, run }), 1);
  assert.match(errors.join("\n"), /feat\/1-a.*other@example\.com.*qc@example\.com/);
  assert.throws(() => git(dir, "merge-base", "--is-ancestor", "feat/1-a", "HEAD"));
});

for (const exists of [false, true]) {
  test(`an invalid author identity stops before switching to an ${exists ? "existing" : "absent"} integration branch`, async (t) => {
    const dir = batch(t);
    if (exists) git(dir, "branch", "feat/7-integration", "main");
    const before = git(dir, "rev-parse", "HEAD");
    authorEnvironment(t, { GIT_AUTHOR_NAME: "", GIT_AUTHOR_EMAIL: "" });
    const errors = [];
    t.mock.method(console, "error", quiet(errors));
    assert.equal(await runIntegrate(config(dir, null), ["--issue", "7", "feat/1-a"], { say: () => {}, run }), 1);
    assert.match(errors.join("\n"), /git var GIT_AUTHOR_IDENT/);
    assert.equal(git(dir, "branch", "--show-current"), "main");
    assert.equal(git(dir, "rev-parse", "HEAD"), before);
    assert.equal(git(dir, "status", "--porcelain"), "");
    if (!exists) assert.throws(() => git(dir, "show-ref", "--verify", "refs/heads/feat/7-integration"));
  });
}

for (const exists of [false, true]) {
  test(`an invalid committer identity stops before fetching or switching to an ${exists ? "existing" : "absent"} integration branch`, async (t) => {
    const dir = batchWithOrigin(t);
    if (exists) git(dir, "branch", "feat/7-integration", "main");
    const before = git(dir, "rev-parse", "HEAD");
    authorEnvironment(t, {
      GIT_AUTHOR_NAME: "qc",
      GIT_AUTHOR_EMAIL: "qc@example.com",
      GIT_COMMITTER_NAME: "",
      GIT_COMMITTER_EMAIL: "",
    });
    const errors = [];
    t.mock.method(console, "error", quiet(errors));
    assert.equal(await runIntegrate(config(dir, null), ["--issue", "7", "feat/1-a"], { say: () => {}, run }), 1);
    assert.match(errors.join("\n"), /git var GIT_COMMITTER_IDENT/);
    assert.equal(existsSync(path.join(dir, ".git", "FETCH_HEAD")), false);
    assert.equal(git(dir, "branch", "--show-current"), "main");
    assert.equal(git(dir, "rev-parse", "HEAD"), before);
    assert.equal(git(dir, "status", "--porcelain"), "");
    if (!exists) assert.throws(() => git(dir, "show-ref", "--verify", "refs/heads/feat/7-integration"));
  });
}

test("--pr opens a draft pull request and strips origin from the base", async (t) => {
  const dir = batchWithOrigin(t);
  git(dir, "push", "origin", "main");
  const io = pullRequestIo(dir);
  const argv = ["--pr", "--issue", "7", "--from", "origin/main", "feat/1-a", "feat/2-b"];
  assert.equal(await runIntegrate(config(dir), argv, io), 0);
  assert.deepEqual(io.events.filter(Array.isArray), pullRequestCalls);
  assert.ok(io.events.includes("pr     https://github.com/example/repo/pull/9"));
});

test("--pr strips another remote from the base", async (t) => {
  const dir = batchWithOrigin(t);
  git(dir, "remote", "add", "upstream", git(dir, "remote", "get-url", "origin"));
  git(dir, "push", "origin", "main");
  git(dir, "fetch", "upstream");
  const io = pullRequestIo(dir);
  assert.equal(await runIntegrate(config(dir), ["--pr", "--issue", "7", "--from", "upstream/main", "feat/1-a"], io), 0);
  assert.deepEqual(io.events.filter(Array.isArray), pullRequestCalls);
});

test("--pr from a sha uses integrate.base or main", async (t) => {
  for (const base of [undefined, "origin/release"]) {
    await t.test(String(base), async (t) => {
      const dir = batchWithOrigin(t);
      git(dir, "branch", "release", "main");
      git(dir, "push", "origin", "release");
      const settings = { ...config(dir), integrate: { base } };
      const io = pullRequestIo(dir);
      assert.equal(await runIntegrate(settings, ["--pr", "--issue", "7", "--from", git(dir, "rev-parse", "main"), "feat/1-a"], io), 0);
      const calls = structuredClone(pullRequestCalls);
      calls[1][calls[1].indexOf("--base") + 1] = base ? "release" : "main";
      assert.deepEqual(io.events.filter(Array.isArray), calls);
    });
  }
});

test("--pr rejects a base that is not a branch before any gh call", async (t) => {
  for (const base of ["HEAD~1", "HEAD", "v1", "bad..branch", "sha"]) {
    await t.test(base, async (t) => {
      const dir = batchWithOrigin(t);
      git(dir, "tag", "v1", "main");
      const settings = { ...config(dir), integrate: { base: base === "sha" ? git(dir, "rev-parse", "main") : base } };
      const errors = [];
      t.mock.method(console, "error", quiet(errors));
      const io = pullRequestIo(dir);
      const before = git(dir, "rev-parse", "HEAD");
      assert.equal(await runIntegrate(settings, ["--pr", "--issue", "7", "--from", git(dir, "rev-parse", "main"), "feat/1-a"], io), 1);
      assert.match(errors.join("\n"), /base.*branch/i);
      assert.deepEqual(io.events, []);
      assert.equal(git(dir, "rev-parse", "HEAD"), before);
    });
  }
});

test("integrate refuses every other author before merging that branch", async (t) => {
  const dir = batch(t);
  git(dir, "switch", "-q", "feat/2-b");
  for (const email of ["first@example.com", "second@example.com"]) {
    git(dir, "config", "user.email", email);
    commitFile(dir, `${email}.txt`, `${email}\n`);
  }
  git(dir, "config", "user.email", "qc@example.com");
  git(dir, "switch", "-q", "main");
  const errors = [];
  t.mock.method(console, "error", quiet(errors));
  assert.equal(await runIntegrate(config(dir, null), ["--issue", "7", "--from", "main", "feat/1-a", "feat/2-b"], { say: () => {}, run }), 1);
  for (const value of ["feat/2-b", "first@example.com", "second@example.com"]) assert.ok(errors.join("\n").includes(value));
  git(dir, "merge-base", "--is-ancestor", "feat/1-a", "HEAD");
  assert.throws(() => git(dir, "merge-base", "--is-ancestor", "feat/2-b", "HEAD"));
  assert.equal(existsSync(path.join(dir, "first@example.com.txt")), false);
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("--pr reports an existing pull request without creating another", async (t) => {
  const dir = batchWithOrigin(t);
  const io = pullRequestIo(dir, { view: '{"number":9}' });
  assert.equal(await runIntegrate(config(dir), ["--pr", "--issue", "7", "--from", "main", "feat/1-a"], io), 0);
  assert.deepEqual(io.events.filter(Array.isArray), [pullRequestCalls[0]]);
  assert.ok(io.events.includes("pr     exists"));
});

test("integrate without --pr never calls gh", async (t) => {
  const dir = batchWithOrigin(t);
  const io = pullRequestIo(dir);
  assert.equal(await runIntegrate(config(dir), ["--issue", "7", "--from", "main", "feat/1-a"], io), 0);
  assert.deepEqual(io.events.filter(Array.isArray), []);
});

test("--pr needs a pushed branch before any merge", async (t) => {
  for (const reason of ["push disabled", "origin absent"]) {
    await t.test(reason, async (t) => {
      const dir = reason === "push disabled" ? batchWithOrigin(t) : batch(t);
      const settings = { ...config(dir), integrate: { push: reason !== "push disabled" } };
      const before = git(dir, "rev-parse", "HEAD");
      const errors = [];
      t.mock.method(console, "error", quiet(errors));
      const io = pullRequestIo(dir);
      assert.equal(await runIntegrate(settings, ["--pr", "--issue", "7", "--from", "main", "feat/1-a"], io), 1);
      assert.match(errors.join("\n"), /pull request needs a pushed branch/i);
      assert.equal(git(dir, "rev-parse", "HEAD"), before);
      assert.equal(git(dir, "branch", "--show-current"), "main");
      assert.deepEqual(io.events, []);
    });
  }
});

test("--pr creates the pull request before the second cadence push", async (t) => {
  const dir = batchWithOrigin(t);
  const io = pullRequestIo(dir);
  const settings = { ...config(dir), integrate: { ciEvery: 2 } };
  const argv = ["--pr", "--issue", "7", "--from", "main", "feat/1-a", "feat/2-b", "feat/3-c"];
  assert.equal(await runIntegrate(settings, argv, io), 0);
  assert.deepEqual(io.events.filter(Array.isArray), pullRequestCalls);
  const pushes = io.events.flatMap((event, i) => typeof event === "string" && event.startsWith("push") ? [i] : []);
  assert.equal(pushes.length, 2);
  const created = io.events.findIndex((event) => Array.isArray(event) && event[1] === "create");
  assert.ok(pushes[0] < created && created < pushes[1]);
});

test("--pr reports gh pr create when creation fails", async (t) => {
  const dir = batchWithOrigin(t);
  const io = pullRequestIo(dir, { create: null });
  const errors = [];
  t.mock.method(console, "error", quiet(errors));
  assert.equal(await runIntegrate(config(dir), ["--pr", "--issue", "7", "--from", "main", "feat/1-a"], io), 1);
  assert.match(errors.join("\n"), /gh pr create/);
  assert.deepEqual(io.events.filter(Array.isArray), pullRequestCalls);
});

test("--pr opens the pull request for an existing remote branch without another push", async (t) => {
  const dir = batchWithOrigin(t);
  const argv = ["--issue", "7", "--from", "main", "feat/1-a"];
  assert.equal(await runIntegrate(config(dir), argv, { say: () => {}, run }), 0);
  const io = pullRequestIo(dir);
  assert.equal(await runIntegrate(config(dir), ["--pr", ...argv], io), 0);
  assert.deepEqual(io.events.filter(Array.isArray), pullRequestCalls);
  assert.equal(io.events.filter((event) => typeof event === "string" && event.startsWith("push")).length, 0);
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
