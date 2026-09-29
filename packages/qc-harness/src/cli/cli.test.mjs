import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { load, requiredHooks } from "../config.mjs";
import { hookDrift } from "./git-hooks.mjs";
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
  for (const file of ["qc.config.json", "docs/decisions.md", "docs/enforcement.md", "docs/pagination.md", ".githooks/pre-commit", ".githooks/commit-msg", ".githooks/pre-push"]) {
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

test("a fresh init repository with the default config passes the hooks check", async () => {
  const dir = repo();
  await quiet(() => runInit(load(dir)));
  const config = load(dir);
  assert.deepEqual(hookDrift(dir, requiredHooks(config)).problems, []);
  rmSync(dir, { recursive: true, force: true });
});

test("a config with only extraExemptHelpers checks the kit defaults and the extra helper", async () => {
  const dir = repo();
  await quiet(() => runInit(load(dir)));
  const config = JSON.parse(readFileSync(path.join(dir, "qc.config.json"), "utf8"));
  config.tenantPredicate = {
    extraExemptHelpers: [{ module: "backend/src/application/sql/bulk.ts", name: "insertMany", argument: 1 }],
  };
  write(dir, {
    "qc.config.json": JSON.stringify(config),
    "backend/src/application/orders.ts": [
      'import { insertReturning } from "./sql/crud";',
      'import { insertMany } from "./sql/bulk";',
      "export function place(tx, v) {",
      '  insertReturning(tx, "orders", ["id"], v);',
      '  insertMany(tx, ["id"]);',
      "}",
      "",
    ].join("\n"),
  });
  const { problems } = await runCheck(load(dir));
  const helperCalls = problems.filter((problem) => problem.rule === "unscoped-helper-call");
  assert.equal(helperCalls.length, 2, "the default helper and the extra helper are each checked");
  assert.match(helperCalls.map((problem) => problem.detail).join("\n"), /insertReturning/);
  assert.match(helperCalls.map((problem) => problem.detail).join("\n"), /insertMany/);
  assert.ok(!problems.some((problem) => problem.rule === "dropped-default-helper"), "appending drops no default");
  rmSync(dir, { recursive: true, force: true });
});

test("a config whose exemptHelpers omits a default fails the check as dropped-default-helper", async () => {
  const dir = repo();
  await quiet(() => runInit(load(dir)));
  const config = JSON.parse(readFileSync(path.join(dir, "qc.config.json"), "utf8"));
  config.gates = { ...config.gates, "config-floor": true };
  config.tenantPredicate = { exemptHelpers: [{ module: "backend/src/application/sql/crud.ts", name: "insertReturning", argument: 2 }] };
  write(dir, { "qc.config.json": JSON.stringify(config) });
  const { problems } = await runCheck(load(dir));
  const dropped = problems.filter((problem) => problem.rule === "dropped-default-helper");
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].detail, /updateVersionedRow/);
  rmSync(dir, { recursive: true, force: true });
});

test("a default also listed in extraExemptHelpers gives one unscoped-helper-call per call", async () => {
  const dir = repo();
  await quiet(() => runInit(load(dir)));
  const config = JSON.parse(readFileSync(path.join(dir, "qc.config.json"), "utf8"));
  config.tenantPredicate = {
    extraExemptHelpers: [{ module: "backend/src/application/sql/crud.ts", name: "insertReturning", argument: 2 }],
  };
  write(dir, {
    "qc.config.json": JSON.stringify(config),
    "backend/src/application/orders.ts": [
      'import { insertReturning } from "./sql/crud";',
      "export function place(tx, v) {",
      '  insertReturning(tx, "orders", ["id"], v);',
      "}",
      "",
    ].join("\n"),
  });
  const { problems } = await runCheck(load(dir));
  assert.equal(problems.filter((problem) => problem.rule === "unscoped-helper-call").length, 1);
  rmSync(dir, { recursive: true, force: true });
});

// The tenant-predicate gate reads how a caller imports an exempt helper. These run the whole check,
// so the wiring in `check.mjs` (the tsconfig read, the alias map, the two rules) is under test too.
const HELPER_RULES = new Set(["unscoped-helper-call", "unresolved-helper-import"]);
const CRUD_SOURCE = "export function insertReturning() {}\n";
const helperProblems = (problems) => problems.filter((problem) => HELPER_RULES.has(problem.rule)).map(({ path: file, rule }) => ({ file, rule }));

async function helperRepo(files, config = {}) {
  const dir = repo();
  write(dir, { "qc.config.json": JSON.stringify({ featureRoots: ["backend/src/features"], ...config }), ...files });
  return dir;
}

test("check resolves an alias call through the tsconfig, and an unscoped one fails", async () => {
  const dir = await helperRepo({
    "tsconfig.json": '{ // a comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["backend/src/*"], }, }, }',
    "backend/src/application/sql/crud.ts": CRUD_SOURCE,
    "backend/src/features/a/bad.ts": 'import { insertReturning } from "@/application/sql/crud.js";\ninsertReturning(tx, "a", ["id"], v);\n',
    "backend/src/features/a/good.ts": 'import { insertReturning } from "@/application/sql/crud.js";\ninsertReturning(tx, "a", ["id", "tenant_id"], v);\n',
  });
  const { problems } = await runCheck(load(dir));
  assert.deepEqual(helperProblems(problems), [{ file: "backend/src/features/a/bad.ts", rule: "unscoped-helper-call" }]);
  rmSync(dir, { recursive: true, force: true });
});

test("check fails a barrel import it cannot read, naming the file", async () => {
  const dir = await helperRepo({
    "backend/src/application/sql/crud.ts": CRUD_SOURCE,
    "backend/src/features/a/x.ts": 'import { insertReturning } from "../../application/sql/index.js";\n',
  });
  const { problems } = await runCheck(load(dir));
  assert.deepEqual(helperProblems(problems), [{ file: "backend/src/features/a/x.ts", rule: "unresolved-helper-import" }]);
  rmSync(dir, { recursive: true, force: true });
});

test("check follows a renamed re-export in a barrel one level", async () => {
  const dir = await helperRepo({
    "backend/src/application/sql/crud.ts": CRUD_SOURCE,
    "backend/src/application/sql/index.ts": 'export { insertReturning as insertRow } from "./crud.js";\n',
    "backend/src/features/a/x.ts": 'import { insertRow } from "../../application/sql/index.js";\ninsertRow(tx, "a", ["id"], v);\n',
  });
  const { problems } = await runCheck(load(dir));
  assert.deepEqual(helperProblems(problems), [{ file: "backend/src/features/a/x.ts", rule: "unscoped-helper-call" }]);
  rmSync(dir, { recursive: true, force: true });
});

test("check reports a tsconfig it cannot parse, at the tsconfig", async () => {
  const dir = await helperRepo({
    "tsconfig.json": "{ not json",
    "backend/src/application/sql/crud.ts": CRUD_SOURCE,
    "backend/src/features/a/x.ts": 'import { insertReturning } from "@/application/sql/crud.js";\n',
  });
  const { problems } = await runCheck(load(dir));
  assert.deepEqual(
    helperProblems(problems).sort((a, b) => a.file.localeCompare(b.file)),
    [
      { file: "backend/src/features/a/x.ts", rule: "unresolved-helper-import" },
      { file: "tsconfig.json", rule: "unresolved-helper-import" },
    ],
  );
  rmSync(dir, { recursive: true, force: true });
});

test("tenantPredicate.tsconfig points at the file that holds the paths, and its targets resolve from its folder", async () => {
  const dir = await helperRepo(
    {
      "backend/tsconfig.json": '{ "compilerOptions": { "paths": { "@/*": ["src/*"] } } }',
      "backend/src/application/sql/crud.ts": CRUD_SOURCE,
      "backend/src/features/a/x.ts": 'import { insertReturning } from "@/application/sql/crud.js";\ninsertReturning(tx, "a", ["id"], v);\n',
    },
    { tenantPredicate: { tsconfig: "backend/tsconfig.json" } },
  );
  const { problems } = await runCheck(load(dir));
  assert.deepEqual(helperProblems(problems), [{ file: "backend/src/features/a/x.ts", rule: "unscoped-helper-call" }]);
  rmSync(dir, { recursive: true, force: true });
});

test("with the default tsconfig absent, an alias import fails closed", async () => {
  const dir = await helperRepo({
    "backend/tsconfig.json": '{ "compilerOptions": { "paths": { "@/*": ["src/*"] } } }',
    "backend/src/application/sql/crud.ts": CRUD_SOURCE,
    "backend/src/features/a/x.ts": 'import { insertReturning } from "@/application/sql/crud.js";\n',
  });
  const { problems } = await runCheck(load(dir));
  assert.deepEqual(helperProblems(problems), [{ file: "backend/src/features/a/x.ts", rule: "unresolved-helper-import" }]);
  rmSync(dir, { recursive: true, force: true });
});

test("check follows a helper renamed through two barrels", async () => {
  const dir = await helperRepo({
    "backend/src/application/sql/crud.ts": CRUD_SOURCE,
    "backend/src/application/sql/inner.ts": 'export { insertReturning as insertRow } from "./crud.js";\n',
    "backend/src/application/sql/index.ts": 'export { insertRow as put } from "./inner.js";\n',
    "backend/src/features/a/x.ts": 'import { put } from "../../application/sql/index.js";\nput(tx, "a", ["id"], v);\n',
  });
  const { problems } = await runCheck(load(dir));
  assert.deepEqual(helperProblems(problems), [{ file: "backend/src/features/a/x.ts", rule: "unscoped-helper-call" }]);
  rmSync(dir, { recursive: true, force: true });
});

test("check treats a scanned file with no import as read, and one outside the scanned roots as untraceable", async () => {
  const dir = await helperRepo({
    "backend/src/application/sql/crud.ts": CRUD_SOURCE,
    "backend/src/application/sql/plain.ts": "export const plain = 1;\n",
    "backend/src/application/sql/index.ts": 'export { plain as p } from "./plain.js";\nexport { thing as t } from "../../../../vendor/lib.js";\n',
    "backend/src/features/a/x.ts": 'import { p } from "../../application/sql/index.js";\n',
    "backend/src/features/a/y.ts": 'import { t } from "../../application/sql/index.js";\n',
  });
  const { problems } = await runCheck(load(dir));
  assert.deepEqual(helperProblems(problems), [{ file: "backend/src/features/a/y.ts", rule: "unresolved-helper-import" }]);
  rmSync(dir, { recursive: true, force: true });
});

test("check follows a default export of a helper module that has no import or re-export", async () => {
  const dir = await helperRepo({
    "backend/src/application/sql/crud.ts": "export function insertReturning() {}\nexport default insertReturning;\n",
    "backend/src/features/a/x.ts": 'import put from "../../application/sql/crud.js";\nput(tx, "a", ["id"], v);\n',
  });
  const { problems } = await runCheck(load(dir));
  assert.deepEqual(helperProblems(problems), [{ file: "backend/src/features/a/x.ts", rule: "unscoped-helper-call" }]);
  rmSync(dir, { recursive: true, force: true });
});

test("check follows an export const alias, and fails a file that aliases the helper in its body", async () => {
  const dir = await helperRepo({
    "backend/src/application/sql/crud.ts": CRUD_SOURCE,
    "backend/src/application/sql/index.ts": 'import { insertReturning } from "./crud.js";\nexport const insertRow = insertReturning;\n',
    "backend/src/features/a/x.ts": 'import { insertRow } from "../../application/sql/index.js";\ninsertRow(tx, "a", ["id"], v);\n',
    "backend/src/features/a/y.ts": 'import { insertReturning } from "../../application/sql/crud.js";\nconst f = insertReturning;\nf(tx, "a", ["id"], v);\n',
  });
  const { problems } = await runCheck(load(dir));
  assert.deepEqual(
    helperProblems(problems).sort((a, b) => a.file.localeCompare(b.file)),
    [
      { file: "backend/src/features/a/x.ts", rule: "unscoped-helper-call" },
      { file: "backend/src/features/a/y.ts", rule: "unresolved-helper-import" },
    ],
  );
  rmSync(dir, { recursive: true, force: true });
});
