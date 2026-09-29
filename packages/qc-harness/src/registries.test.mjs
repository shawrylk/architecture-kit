import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { literalRegistries } from "./registries.mjs";

function inDir(files, run) {
  const dir = mkdtempSync(path.join(tmpdir(), "qc-literal-registries-"));
  try {
    for (const [file, contents] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), contents);
    }
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const config = (root) => ({ ...(root === undefined ? {} : { root }), thresholds: "quality-thresholds.json", versions: "versions.json", registryLiteral: {} });

test("a config with no root reads from the working directory", () => {
  const cwd = process.cwd();
  inDir({ "quality-thresholds.json": JSON.stringify({ gates: { coverage: { value: 70 } } }) }, (dir) => {
    process.chdir(dir);
    try {
      const { list, problems } = literalRegistries(config());
      assert.deepEqual(problems, []);
      assert.deepEqual(Object.keys(list[0].entries), ["coverage"]);
    } finally {
      process.chdir(cwd);
    }
  });
});

test("a null or non-object entry is dropped, and the rest stay", () => {
  const gates = { coverage: { value: 70, readers: ["a.ts"] }, empty: null, figure: 3, list: [1], text: "x" };
  inDir({ "quality-thresholds.json": JSON.stringify({ gates }) }, (dir) => {
    const { list, problems } = literalRegistries(config(dir));
    assert.deepEqual(problems, []);
    assert.deepEqual(Object.keys(list[0].entries), ["coverage"]);
  });
});
