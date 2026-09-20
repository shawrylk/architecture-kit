import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { load } from "../config.mjs";
import { runInit } from "./init.mjs";
import { installHooks } from "./install-hooks.mjs";
import { runCheck } from "./check.mjs";

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "qc-cli-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(path.join(dir, "package.json"), '{"name":"t","private":true,"type":"module"}\n');
  return dir;
}

const quiet = (run) => {
  const log = console.log;
  console.log = () => {};
  try {
    return run();
  } finally {
    console.log = log;
  }
};

test("init writes the documents the gates read", async () => {
  const dir = repo();
  await quiet(() => runInit(load(dir)));
  for (const file of ["qc.config.json", "docs/decisions.md", "docs/enforcement.md", "docs/pagination.md", ".githooks/pre-commit", ".githooks/pre-push"]) {
    assert.ok(existsSync(path.join(dir, file)), `${file} is missing`);
  }
  rmSync(dir, { recursive: true, force: true });
});

// The examples cite ids the shipped register does not define; a repository that
// took them would fail its own citations gate on the first run.
test("init does not copy the decision examples", async () => {
  const dir = repo();
  await quiet(() => runInit(load(dir)));
  assert.equal(existsSync(path.join(dir, "docs/decisions.examples.md")), false);
  rmSync(dir, { recursive: true, force: true });
});

test("init leaves a file that already exists alone, and --force replaces it", async () => {
  const dir = repo();
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  writeFileSync(path.join(dir, "docs/decisions.md"), "mine\n");
  await quiet(() => runInit(load(dir)));
  assert.equal(readFileSync(path.join(dir, "docs/decisions.md"), "utf8"), "mine\n");
  await quiet(() => runInit(load(dir), ["--force"]));
  assert.notEqual(readFileSync(path.join(dir, "docs/decisions.md"), "utf8"), "mine\n");
  rmSync(dir, { recursive: true, force: true });
});

test("init adds the scripts its own docs reference, without touching one already set", async () => {
  const dir = repo();
  writeFileSync(path.join(dir, "package.json"), '{"name":"t","type":"module","scripts":{"spec:check":"mine"}}\n');
  await quiet(() => runInit(load(dir)));
  const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(manifest.scripts["spec:check"], "mine");
  assert.equal(manifest.scripts.prepare, "qc install-hooks");
  rmSync(dir, { recursive: true, force: true });
});

test("install-hooks points git at the hook directory", async () => {
  const dir = repo();
  await quiet(() => runInit(load(dir)));
  await quiet(() => installHooks(load(dir)));
  const configured = execFileSync("git", ["config", "core.hooksPath"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(configured, ".githooks");
  rmSync(dir, { recursive: true, force: true });
});

test("install-hooks refuses before init rather than configuring nothing", async () => {
  const dir = repo();
  const error = console.error;
  console.error = () => {};
  const previous = process.exitCode;
  try {
    await installHooks(load(dir));
    assert.equal(process.exitCode, 1);
  } finally {
    console.error = error;
    process.exitCode = previous;
  }
  rmSync(dir, { recursive: true, force: true });
});

// A config whose roots all point at nothing sweeps nothing, and every gate downstream of the
// sweep then passes on an empty set. The run has to say so rather than report a green wall.
test("a config whose every feature root is missing is a problem", async () => {
  const dir = repo();
  await quiet(() => runInit(load(dir)));
  const { problems, lines } = await runCheck(load(dir));
  assert.ok(
    problems.some((problem) => problem.rule === "unfound-root"),
    "a repository with neither configured root present reported no problem",
  );
  assert.ok(
    !lines.some((line) => line.includes("OK  structure")),
    "the structure line claimed a pass while the roots matched nothing",
  );
  rmSync(dir, { recursive: true, force: true });
});

// One root missing is ordinary: a repository with no frontend is not misconfigured.
test("one present feature root is enough", async () => {
  const dir = repo();
  await quiet(() => runInit(load(dir)));
  mkdirSync(path.join(dir, "backend/src/features"), { recursive: true });
  const { problems } = await runCheck(load(dir));
  assert.ok(
    !problems.some((problem) => problem.rule === "unfound-root"),
    "a repository with one real root was reported as pointing at nothing",
  );
  rmSync(dir, { recursive: true, force: true });
});
