import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { load } from "../config.mjs";
import { runCheck } from "./check.mjs";

const THRESHOLDS = { gates: { coverage: { value: 70, unit: "percent", comparator: "min", match: ["coverage threshold"] } } };
const VERSIONS = { libraries: { node: { label: "Node.js", version: "24" } } };
const LIFETIMES = { lifetimes: { accesstoken: { value: 15, unit: "minutes", match: ["access token lifetime"] } } };
const RULES = new Set(["threshold-literal", "version-literal", "stale-annotated-number", "unknown-token", "registry-literal"]);

/** A git repository holding the registries, one doc and a config. A file set to `null` is left out. */
function fixture({ registryLiteral, doc, files = {} }) {
  const dir = mkdtempSync(path.join(tmpdir(), "qc-registries-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const all = {
    "package.json": '{"name":"t","private":true,"type":"module"}',
    "quality-thresholds.json": JSON.stringify(THRESHOLDS),
    "versions.json": JSON.stringify(VERSIONS),
    "session-lifetimes.json": JSON.stringify(LIFETIMES),
    "qc.config.json": JSON.stringify({
      docs: { root: "docs", decisions: "docs/decisions.md", enforcement: "docs/enforcement.md" },
      featureRoots: [],
      gates: { "registry-literal": true },
      ...(registryLiteral === undefined ? {} : { registryLiteral }),
    }),
    "docs/a.md": doc,
    ...files,
  };
  for (const [file, contents] of Object.entries(all)) {
    if (contents === null) continue;
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), contents);
  }
  return dir;
}

async function problemsOf(options) {
  const dir = fixture(options);
  try {
    const { problems } = await runCheck(load(dir));
    return problems.filter((problem) => RULES.has(problem.rule));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const rulesOf = (problems) => problems.map((problem) => problem.rule);
const ttl = { path: "session-lifetimes.json", key: "lifetimes", prefix: "ttl" };

test("no registries set: the thresholds and the versions apply", async () => {
  const bare = await problemsOf({ doc: "The coverage threshold is 70%.\n\nRuns on Node.js 24." });
  assert.deepEqual(rulesOf(bare).sort(), ["threshold-literal", "version-literal"]);
  const annotated = await problemsOf({ doc: "The coverage threshold is 70 <!-- q:coverage -->%.\n\nNode.js 24 <!-- ver:node -->." });
  assert.deepEqual(annotated, []);
  const stale = await problemsOf({ doc: "Node.js 25 <!-- v:node -->." });
  assert.deepEqual(rulesOf(stale), ["stale-annotated-number"]);
});

test("a ttl item keeps the threshold registry, and catches a stale and an unknown ttl id", async () => {
  const registryLiteral = { registries: [ttl] };
  const bare = await problemsOf({ registryLiteral, doc: "The coverage threshold is 70%.\n\nThe access token lifetime is 15 minutes." });
  assert.deepEqual(rulesOf(bare), ["threshold-literal", "threshold-literal"]);
  assert.match(bare.map((problem) => problem.detail).join("\n"), /\{\{ttl:accesstoken\}\}/);
  const stale = await problemsOf({ registryLiteral, doc: "Access token lifetime 20 <!-- ttl:accesstoken --> minutes.\n\nSee 1 <!-- ttl:nope -->." });
  assert.deepEqual(rulesOf(stale), ["stale-annotated-number", "unknown-token"]);
  const clean = await problemsOf({ registryLiteral, doc: "Access token lifetime 15 <!-- ttl:accesstoken --> minutes." });
  assert.deepEqual(clean, []);
});

test("an item with the path of a default overrides it", async () => {
  const registryLiteral = { registries: [{ path: "quality-thresholds.json", key: "gates", prefix: "thr" }] };
  assert.deepEqual(await problemsOf({ registryLiteral, doc: "The coverage threshold is 70 <!-- thr:coverage -->%." }), []);
  const old = await problemsOf({ registryLiteral, doc: "The coverage threshold is 70 <!-- q:coverage -->%." });
  assert.deepEqual(rulesOf(old), ["threshold-literal"]);
  // The versions default stays.
  const version = await problemsOf({ registryLiteral, doc: "Node.js 25 <!-- ver:node -->." });
  assert.deepEqual(rulesOf(version), ["stale-annotated-number"]);
});

test("a malformed item is a problem at qc.config.json, and the rest still run", async () => {
  const registries = [
    { path: "session-lifetimes.json" },
    { path: "session-lifetimes.json", key: "lifetimes", prefix: "bad prefix" },
    { path: "session-lifetimes.json", key: "lifetimes", prefix: "" },
    { path: "session-lifetimes.json", key: "lifetimes", prefix: ["ok", 3] },
    { path: "session-lifetimes.json", key: "lifetimes", prefix: "ttl", valueKey: 5 },
    { path: "session-lifetimes.json", key: "lifetimes", prefix: "ttl", unitKey: {} },
    "text",
  ];
  const problems = await problemsOf({ registryLiteral: { registries }, doc: "The coverage threshold is 70%." });
  const config = problems.filter((problem) => problem.rule === "registry-literal");
  assert.equal(config.length, registries.length);
  assert.ok(config.every((problem) => problem.path === "qc.config.json"));
  assert.deepEqual(rulesOf(problems.filter((problem) => problem.rule !== "registry-literal")), ["threshold-literal"]);
});

test("registries that is not a list is a problem", async () => {
  const problems = await problemsOf({ registryLiteral: { registries: ttl }, doc: "Nothing here." });
  assert.deepEqual(rulesOf(problems), ["registry-literal"]);
  assert.equal(problems[0].path, "qc.config.json");
});

test("a listed registry that is missing, unreadable or without its key is a problem", async () => {
  const missing = await problemsOf({ registryLiteral: { registries: [{ ...ttl, path: "nope.json" }] }, doc: "Nothing here." });
  assert.deepEqual(rulesOf(missing), ["registry-literal"]);
  assert.match(missing[0].detail, /nope\.json/);
  const broken = await problemsOf({ registryLiteral: { registries: [ttl] }, doc: "Nothing here.", files: { "session-lifetimes.json": "{" } });
  assert.deepEqual(rulesOf(broken), ["registry-literal"]);
  const noKey = await problemsOf({ registryLiteral: { registries: [{ ...ttl, key: "other" }] }, doc: "Nothing here." });
  assert.deepEqual(rulesOf(noKey), ["registry-literal"]);
  const notObject = await problemsOf({
    registryLiteral: { registries: [ttl] },
    doc: "Nothing here.",
    files: { "session-lifetimes.json": '{"lifetimes":[]}' },
  });
  assert.deepEqual(rulesOf(notObject), ["registry-literal"]);
});

test("a default registry whose file is absent stays silent", async () => {
  const problems = await problemsOf({ doc: "Nothing here.", files: { "versions.json": null, "quality-thresholds.json": null } });
  assert.deepEqual(problems, []);
});

test("a default registry whose file is unreadable is a problem", async () => {
  const problems = await problemsOf({ doc: "Nothing here.", files: { "versions.json": "{" } });
  assert.deepEqual(rulesOf(problems), ["registry-literal"]);
});

test("two registries that share a prefix are a problem", async () => {
  const problems = await problemsOf({ registryLiteral: { registries: [{ ...ttl, prefix: ["ttl", "q"] }] }, doc: "Nothing here." });
  assert.deepEqual(rulesOf(problems), ["registry-literal"]);
  assert.match(problems[0].detail, /'q'/);
  assert.equal(problems[0].path, "qc.config.json");
});

const READER_RULES = new Set(["missing-reader", "silent-reader"]);

async function readerProblems(files, registryLiteral) {
  const dir = fixture({ registryLiteral, doc: "Nothing here.", files });
  try {
    const { problems } = await runCheck(load(dir));
    return problems.filter((problem) => READER_RULES.has(problem.rule));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const lifetimes = (readers) => JSON.stringify({ lifetimes: { accesstoken: { value: 15, unit: "minutes", readers } } });
const thresholdsWith = (readers) => JSON.stringify({ gates: { coverage: { value: 70, unit: "percent", comparator: "min", readers } } });

test("registry-readers: a ttl entry naming a missing reader fails", async () => {
  const problems = await readerProblems({ "session-lifetimes.json": lifetimes(["src/auth.ts"]) }, { registries: [ttl] });
  assert.deepEqual(problems.map((problem) => [problem.rule, problem.path]), [["missing-reader", "src/auth.ts"]]);
  assert.match(problems[0].detail, /accesstoken/);
});

test("registry-readers: a ttl reader that does not name its entry fails, and one that does passes", async () => {
  const silent = await readerProblems(
    { "session-lifetimes.json": lifetimes(["src/auth.ts"]), "src/auth.ts": "export const x = 1;\n" },
    { registries: [ttl] },
  );
  assert.deepEqual(silent.map((problem) => [problem.rule, problem.path]), [["silent-reader", "src/auth.ts"]]);
  const named = await readerProblems(
    { "session-lifetimes.json": lifetimes(["src/auth.ts"]), "src/auth.ts": 'export const t = ttl("accesstoken");\n' },
    { registries: [ttl] },
  );
  assert.deepEqual(named, []);
});

test("registry-readers: the thresholds cases are unchanged", async () => {
  const missing = await readerProblems({ "quality-thresholds.json": thresholdsWith(["src/cov.ts"]) });
  assert.deepEqual(missing.map((problem) => [problem.rule, problem.path]), [["missing-reader", "src/cov.ts"]]);
  const silent = await readerProblems({ "quality-thresholds.json": thresholdsWith(["src/cov.ts"]), "src/cov.ts": "export {};\n" });
  assert.deepEqual(silent.map((problem) => problem.rule), ["silent-reader"]);
  const named = await readerProblems({ "quality-thresholds.json": thresholdsWith(["src/cov.ts"]), "src/cov.ts": "gates.coverage\n" });
  assert.deepEqual(named, []);
});
