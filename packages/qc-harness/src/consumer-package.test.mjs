import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importConsumerPackage } from "./consumer-package.mjs";

test("consumer packages resolve beside the consumer, including ESM-only packages", async () => {
  const root = mkdtempSync(join(tmpdir(), "qc-consumer-"));
  try {
    const directory = join(root, "node_modules", "consumer-peer");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module", exports: { import: "./entry.mjs" } }));
    writeFileSync(join(directory, "entry.mjs"), "export const value = 178;");
    assert.equal((await importConsumerPackage("consumer-peer", root)).value, 178);
    await assert.rejects(importConsumerPackage("missing-peer-178", root), { code: "MODULE_NOT_FOUND" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
