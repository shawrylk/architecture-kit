import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { onlyMissingModules, typecheckCommand } from "./typecheck.mjs";

function root(t, files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-typecheck-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

const TSC = { "node_modules/typescript/bin/tsc": "" };

test("a typecheck script wins, run by the package manager of the lockfile", (t) => {
  const dir = root(t, { "package.json": '{ "scripts": { "typecheck": "tsc" } }', "pnpm-lock.yaml": "", "tsconfig.json": "{}", ...TSC });
  assert.deepEqual(typecheckCommand(dir), { cmd: "pnpm", args: ["run", "-s", "typecheck"], shell: true });
});

test("without a script, tsc checks with --noEmit, so no .tsbuildinfo is written", (t) => {
  const dir = root(t, { "package.json": "{}", "tsconfig.json": '{ "compilerOptions": {} }', ...TSC });
  assert.deepEqual(typecheckCommand(dir).args.slice(1), ["--noEmit", "-p", ".", "--pretty", "false"]);
});

test("a tsconfig with project references builds, because --noEmit would check none of them", (t) => {
  const dir = root(t, { "tsconfig.json": '{ "files": [], "references": [{ "path": "a" }] }', ...TSC });
  assert.deepEqual(typecheckCommand(dir).args.slice(1), ["-b", "--pretty", "false"]);
});

test("no script and no tsc means nothing to typecheck", (t) => {
  assert.equal(typecheckCommand(root(t, { "package.json": "{}", "tsconfig.json": "{}" })), null);
});

test("a run whose only errors are TS2307 is retried; any other error is not", () => {
  assert.equal(onlyMissingModules("a.ts(1,1): error TS2307: Cannot find module 'x'."), true);
  assert.equal(onlyMissingModules("a.ts(1,1): error TS2307: x\nb.ts(2,2): error TS2322: y"), false);
  assert.equal(onlyMissingModules("npm ERR! missing script"), false);
});
