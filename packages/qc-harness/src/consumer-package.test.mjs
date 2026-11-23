import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { importConsumerPackage } from "./consumer-package.mjs";

test("consumer packages resolve beside the consumer, including ESM-only packages", async () => {
  const root = mkdtempSync(join(tmpdir(), "qc-consumer-"));
  try {
    for (const name of ["yaml", "playwright", "pngjs", "pixelmatch"]) {
      const directory = join(root, "node_modules", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module", exports: { import: "./entry.mjs" } }));
      writeFileSync(join(directory, "entry.mjs"), "export const value = 178;");
      assert.equal((await importConsumerPackage(name, root)).value, 178);
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("an installed peer with a missing require entry keeps the resolution error", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "qc-broken-peer-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const directory = join(root, "node_modules", "yaml");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ exports: { require: "./missing.cjs" } }));
  const loader = join(root, "consumer-package.mjs");
  cpSync(new URL("./consumer-package.mjs", import.meta.url), loader);
  const { importConsumerPackage: loadPeer } = await import(pathToFileURL(loader).href);
  await assert.rejects(loadPeer("yaml", root), (error) => {
    assert.equal(error.code, "MODULE_NOT_FOUND");
    assert.match(error.message, /missing\.cjs/);
    assert.doesNotMatch(error.message, /Cannot find package 'yaml'/);
    return true;
  });
});

test("consumer package loader rejects names outside the optional peer allowlist", async () => {
  const root = mkdtempSync(join(tmpdir(), "qc-unknown-peer-"));
  try {
    const directory = join(root, "node_modules", "consumer-peer");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ main: "index.cjs" }));
    writeFileSync(join(directory, "index.cjs"), "throw new Error('unknown package executed');");
    for (const name of ["consumer-peer", "missing-peer-178", "node:fs", "yaml/subpath"]) {
      await assert.rejects(importConsumerPackage(name, root), { message: `Unsupported optional peer '${name}'` });
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
