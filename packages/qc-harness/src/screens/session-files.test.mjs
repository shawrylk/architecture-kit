import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { atomicJson, withFileLock } from "./session-files.mjs";

test("parallel processes serialize ledger updates and leave complete private JSON files", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-lock-"));
  const file = path.join(root, "ledger.json");
  const module = new URL("./session-files.mjs", import.meta.url).href;
  const code = `import { readFileSync } from 'node:fs'; import { atomicJson, withFileLock } from ${JSON.stringify(module)}; const file = process.argv[1]; for(let i=0;i<10;i++) await withFileLock(file, async () => { const value = JSON.parse(readFileSync(file)); await new Promise(r => setTimeout(r, 2)); await atomicJson(file, { count: value.count + 1 }); });`;
  try {
    await atomicJson(file, { count: 0 });
    await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code, file]);
      let stderr = "";
      child.stderr.on("data", data => stderr += data);
      child.on("error", reject);
      child.on("exit", code => code === 0 ? resolve() : reject(new Error(stderr)));
    })));
    assert.deepEqual(JSON.parse(readFileSync(file)), { count: 40 });
    assert.deepEqual(readdirSync(root), ["ledger.json"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed writer releases its lock and preserves the previous JSON", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-lock-fail-"));
  const file = path.join(root, "state.json");
  try {
    await atomicJson(file, { old: true });
    await assert.rejects(withFileLock(file, async () => { throw new Error("failed"); }), /failed/);
    assert.deepEqual(JSON.parse(readFileSync(file)), { old: true });
    await withFileLock(file, () => atomicJson(file, { renewed: true }));
    assert.deepEqual(JSON.parse(readFileSync(file)), { renewed: true });
    assert.deepEqual(readdirSync(root), ["state.json"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
