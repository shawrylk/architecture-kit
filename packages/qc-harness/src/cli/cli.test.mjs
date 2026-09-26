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

const MIRROR_RULES = new Set(["unmirrored-test", "orphaned-test", "invalid-mirror-root"]);

/** An initialised repository with two mirror roots, and the given files under it. */
async function mirrored(files) {
  const dir = repo();
  await quiet(() => runInit(load(dir)));
  const roots = [{ src: "frontend/src", tests: "frontend/tests" }, { src: "backend/src", tests: "backend/tests" }];
  writeFileSync(path.join(dir, "qc.config.json"), JSON.stringify({ testMirror: { roots } }));
  for (const file of files) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), "export {};\n");
  }
  return dir;
}

// backend/tests is in no citable root, so only a walk of the configured roots can see its orphan.
test("check judges every configured mirror root, including a tests folder outside the citable roots", async () => {
  const dir = await mirrored([
    "backend/src/orders/place.ts",
    "backend/src/orders/place.test.ts",
    "backend/src/orders/ship.ts",
    "backend/tests/orders/ship.test.ts",
    "backend/tests/orders/cancel.test.ts",
  ]);
  const { problems } = await runCheck(load(dir));
  const found = problems.filter((problem) => MIRROR_RULES.has(problem.rule)).map(({ path: file, rule }) => ({ file, rule }));
  assert.deepEqual(
    found.sort((a, b) => a.file.localeCompare(b.file)),
    [
      { file: "backend/src/orders/place.test.ts", rule: "unmirrored-test" },
      { file: "backend/tests/orders/cancel.test.ts", rule: "orphaned-test" },
    ],
  );
  rmSync(dir, { recursive: true, force: true });
});

const ENGLISH_RULES = new Set(["english-comment", "english-source"]);
const englishPaths = (problems) => problems.filter((problem) => ENGLISH_RULES.has(problem.rule)).map((problem) => problem.path).sort();

function write(dir, files) {
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), contents);
  }
}

// The English gate is a policy gate, so the kit ships it off.
const ENGLISH_ON = JSON.stringify({ featureRoots: ["backend/src/features"], gates: { "english-source": true } });

/** Japanese in a git-ignored folder, under a path in `.git/info/exclude`, and in a tracked file. */
const JAPANESE = {
  "qc.config.json": ENGLISH_ON,
  ".gitignore": ".gitnexus/\n",
  ".gitnexus/wiki/overview.md": "図面の概要\n",
  "local/draft.md": "下書き\n",
  "docs/tracked.md": "検査の手順\n",
};

test("check skips what git ignores and scans what git tracks", async () => {
  const dir = repo();
  await quiet(() => runInit(load(dir)));
  write(dir, JAPANESE);
  writeFileSync(path.join(dir, ".git/info/exclude"), "local/\n");
  execFileSync("git", ["add", "docs/tracked.md"], { cwd: dir });
  const { problems } = await runCheck(load(dir));
  assert.deepEqual(englishPaths(problems), ["docs/tracked.md"]);
  rmSync(dir, { recursive: true, force: true });
});

test("outside git, check walks the tree and still scans every file", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qc-cli-plain-"));
  writeFileSync(path.join(dir, "package.json"), '{"name":"t","private":true,"type":"module"}\n');
  await quiet(() => runInit(load(dir)));
  write(dir, { ...JAPANESE, "node_modules/pkg/readme.md": "日本語\n" });
  const { problems } = await runCheck(load(dir));
  assert.deepEqual(englishPaths(problems), [".gitnexus/wiki/overview.md", "docs/tracked.md", "local/draft.md"]);
  rmSync(dir, { recursive: true, force: true });
});

test("one check lists the repository once, for every gate", async () => {
  const dir = repo();
  await quiet(() => runInit(load(dir)));
  let calls = 0;
  const lister = async (...args) => {
    calls += 1;
    return (await import("./repo-files.mjs")).repoFiles(...args);
  };
  await runCheck(load(dir), [], { lister });
  await runCheck(load(dir), ["docs/decisions.md", "qc.config.json"], { lister });
  assert.equal(calls, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("check with several files reports every problem from each, and judges only those files", async () => {
  const dir = repo();
  await quiet(() => runInit(load(dir)));
  const orders = "backend/src/features/orders";
  const invoices = "backend/src/features/invoices";
  write(dir, {
    "qc.config.json": ENGLISH_ON,
    [`${orders}/index.ts`]: "export {};\n",
    [`${orders}/junk/a.ts`]: "// 注文の補助\nexport {};\n",
    [`${invoices}/index.ts`]: "export {};\n",
    [`${invoices}/junk/b.ts`]: "export {};\n",
    "docs/untouched.md": "触らない\n",
  });
  const { problems } = await runCheck(load(dir), [`${orders}/junk/a.ts`, path.join(dir, invoices, "junk/b.ts")]);
  const features = new Set(problems.filter((problem) => problem.feature).map((problem) => problem.feature.split(path.sep).join("/")));
  assert.deepEqual([...features].sort(), [invoices, orders]);
  assert.deepEqual(englishPaths(problems), [`${orders}/junk/a.ts`]);
  const full = await runCheck(load(dir));
  assert.ok(englishPaths(full.problems).includes("docs/untouched.md"), "no file given must stay the full check");
  rmSync(dir, { recursive: true, force: true });
});

test("a clean mirror run names every root it judged", async () => {
  const dir = await mirrored(["backend/src/orders/ship.ts", "backend/tests/orders/ship.test.ts"]);
  const { lines } = await runCheck(load(dir));
  const line = lines.find((entry) => entry.startsWith("OK  mirror"));
  assert.ok(line?.includes("frontend/tests") && line.includes("backend/tests"), `mirror line: ${line}`);
  rmSync(dir, { recursive: true, force: true });
});
