import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { load } from "../config.mjs";
import { runScaffold } from "./scaffold.mjs";

function repo(withArchitecture) {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "qc-scaffold-")));
  writeFileSync(path.join(dir, "qc.config.json"), `${JSON.stringify({ featureRoots: [] })}\n`);
  if (withArchitecture) {
    mkdirSync(path.join(dir, "docs"));
    writeFileSync(path.join(dir, "docs", "architecture.md"), "# Architecture\n");
  }
  return dir;
}

async function scaffold(dir, args) {
  const { log, error } = console;
  console.log = console.error = () => {};
  try {
    await runScaffold(load(dir), args);
    return process.exitCode;
  } finally {
    Object.assign(console, { log, error });
    process.exitCode = undefined;
  }
}

test("without the reference architecture doc, qc feature refuses and writes nothing", async () => {
  const dir = repo(false);
  try {
    assert.equal(await scaffold(dir, ["orders"]), 1);
    assert.equal(existsSync(path.join(dir, "backend")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("qc feature adds its root to featureRoots once, so the anatomy gate sweeps the new feature", async () => {
  const dir = repo(true);
  try {
    assert.equal(await scaffold(dir, ["orders"]), undefined);
    assert.equal(await scaffold(dir, ["invoices", "--root", "./backend/src/features/"]), undefined);
    assert.ok(existsSync(path.join(dir, "backend", "src", "features", "orders", "schema.ts")));
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "qc.config.json"), "utf8")).featureRoots, ["backend/src/features"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
