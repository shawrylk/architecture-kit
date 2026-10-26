import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaults } from "../config.mjs";

const qc = fileURLToPath(new URL("./qc.mjs", import.meta.url));
const node = (source) => `"${process.execPath}" -e '${source}'`;
const record = node('require("node:fs").writeFileSync("args.json", JSON.stringify(process.argv.slice(1)))');
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });

function fixture(t, check = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "qc-e2e-affected-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "QC test");
  git(root, "config", "user.email", "qc@example.test");
  const config = {
    featureRoots: [],
    gates: Object.fromEntries(Object.keys(defaults.gates).map((key) => [key, false])),
    check: { base: "main", ...check },
  };
  writeFileSync(path.join(root, "qc.config.json"), JSON.stringify(config));
  writeFileSync(path.join(root, "committed.mjs"), "export const value = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "test(qc): seed fixture");
  git(root, "checkout", "-q", "-b", "feat/156-e2e");
  return root;
}

function e2e(root) {
  return spawnSync(process.execPath, [qc, "e2e"], { cwd: root, encoding: "utf8" });
}

test("e2e skips a null command", (t) => {
  const root = fixture(t, { e2e: null });
  const run = e2e(root);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /SKIP  check\.e2e/);
});

test("e2e receives committed and staged files", (t) => {
  const root = fixture(t, { e2e: record });
  writeFileSync(path.join(root, "committed.mjs"), "export const value = 2;\n");
  git(root, "add", "committed.mjs");
  git(root, "commit", "-q", "-m", "test(qc): change shared module");
  writeFileSync(path.join(root, "staged.mjs"), "export {};\n");
  git(root, "add", "staged.mjs");
  const run = e2e(root);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "args.json"), "utf8")), ["committed.mjs", "staged.mjs"]);
});

test("a failing e2e command streams output and preserves its exit code", (t) => {
  const root = fixture(t, { e2e: node('console.log("e2e output"); console.error("e2e error"); process.exit(7)') });
  writeFileSync(path.join(root, "changed.mjs"), "export {};\n");
  git(root, "add", "changed.mjs");
  const run = e2e(root);
  assert.equal(run.status, 7, run.stderr);
  assert.match(run.stdout, /e2e output/);
  assert.match(run.stderr, /e2e error/);
});

test("e2e skips an empty diff without running the command", (t) => {
  const root = fixture(t, { e2e: record });
  const run = e2e(root);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /SKIP  no changed file/);
  assert.equal(existsSync(path.join(root, "args.json")), false);
});
