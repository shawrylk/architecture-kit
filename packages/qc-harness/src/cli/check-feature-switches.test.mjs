import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { load } from "../config.mjs";
import { checkFeatureSwitches } from "../gates/feature-switches.mjs";
import { runCheck } from "./check.mjs";

const view = { path: "src/features/pins/view.tsx", contents: "const SHOW_DELETE = false;" };

function fixture(gates) {
  const dir = mkdtempSync(path.join(tmpdir(), "qc-feature-switches-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const files = {
    "package.json": '{"name":"t","private":true,"type":"module"}',
    "quality-thresholds.json": '{"gates":{}}',
    "versions.json": '{"libraries":{}}',
    "qc.config.json": JSON.stringify({ featureRoots: ["src/features"], gates }),
    [view.path]: view.contents,
    "src/features/pins/feature-switches.ts": "export const PIN_UNWIRED = true;",
    "src/features/pins/view.test.tsx": "const SHOW_TEST = false;",
    "src/features/pins/dist/view.tsx": "const SHOW_DIST = false;",
    "src/features/pins/node_modules/vendor.ts": "const SHOW_VENDOR = false;",
    "src/features/pins/notes.md": "const SHOW_DOC = false;",
    "src/features/root.ts": "const SHOW_ROOT = false;",
    "src/elsewhere/view.tsx": "const SHOW_OTHER = false;",
  };
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), contents);
  }
  return dir;
}

test("runCheck finds declarations in feature source files when the gate is on", async () => {
  const dir = fixture({ "feature-switches": true });
  try {
    const config = load(dir);
    const { problems, lines } = await runCheck(config);
    assert.deepEqual(
      problems.filter((problem) => problem.rule === "unwire-constant-outside-switch-file"),
      checkFeatureSwitches([view], config.featureSwitches, "src/features/pins"),
    );
    assert.equal(problems.filter((problem) => problem.rule === "unwire-constant-outside-switch-file").length, 1);
    assert.ok(lines.includes("FAIL  switches   2 file(s), 1 unwire constant(s) outside feature-switches.ts"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCheck leaves the feature-switches gate off when it is unset", async () => {
  const dir = fixture({});
  try {
    const { problems, lines } = await runCheck(load(dir));
    assert.deepEqual(problems.filter((problem) => problem.rule === "unwire-constant-outside-switch-file"), []);
    assert.ok(lines.every((line) => !line.startsWith("OK  switches")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the gate prints one summary across features and reports failure truthfully", async (t) => {
  const dir = fixture({ "feature-switches": true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "src/features/photos"));
  writeFileSync(path.join(dir, "src/features/photos/view.tsx"), "export const title = 'Photos';");
  const failed = await runCheck(load(dir));
  const summaries = failed.lines.filter((line) => /switches\s/.test(line));
  assert.equal(summaries.length, 1);
  assert.match(summaries[0], /^FAIL\s+switches\s+3 file\(s\)/);
  writeFileSync(path.join(dir, view.path), "export const title = 'Pins';");
  const passed = await runCheck(load(dir));
  assert.deepEqual(passed.lines.filter((line) => /switches\s/.test(line)), ["OK  switches     3 file(s) hold no unwire constant outside feature-switches.ts"]);
});

test("the feature switch gate skips spec files in every source extension", async (t) => {
  const dir = fixture({ "feature-switches": true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, view.path), "export const title = 'Pins';");
  for (const extension of ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]) {
    writeFileSync(path.join(dir, `src/features/pins/view.spec.${extension}`), "const SHOW_SPEC = false;");
  }
  const { problems } = await runCheck(load(dir));
  assert.deepEqual(problems.filter((problem) => problem.rule === "unwire-constant-outside-switch-file"), []);
});

test("a nested switch file receives no root switch exemption", async (t) => {
  const dir = fixture({ "feature-switches": true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const nested = "src/features/pins/nested/feature-switches.ts";
  mkdirSync(path.dirname(path.join(dir, nested)));
  writeFileSync(path.join(dir, nested), "const SHOW_NESTED = false;");
  const { problems } = await runCheck(load(dir));
  const switches = problems.filter((problem) => problem.rule === "unwire-constant-outside-switch-file");
  assert.deepEqual(switches.map(({ path }) => path).sort(), [nested, view.path].sort());
});
