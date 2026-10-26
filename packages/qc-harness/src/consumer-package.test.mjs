import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
    rmSync(root, { recursive: true, force: true });
  }
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
    rmSync(root, { recursive: true, force: true });
  }
});

test("screens without optional peers prints the install hint and exits 2", () => {
  const root = mkdtempSync(join(tmpdir(), "qc-no-peers-"));
  try {
    cpSync(new URL("./", import.meta.url), join(root, "src"), { recursive: true });
    const result = spawnSync(process.execPath, [join(root, "src/cli/qc.mjs"), "screens", "list"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /qc screens needs the (pngjs|pixelmatch|playwright) package/);
    assert.match(result.stderr, /pnpm add -D playwright pixelmatch pngjs/);
    assert.doesNotMatch(result.stderr, /Require stack|at async/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
