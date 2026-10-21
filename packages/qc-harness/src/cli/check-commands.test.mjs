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
  const root = mkdtempSync(path.join(tmpdir(), "qc-check-commands-"));
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
  writeFileSync(path.join(root, "unstaged.mjs"), "export {};\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "test(qc): seed fixture");
  git(root, "checkout", "-q", "-b", "feat/170-related");
  return root;
}

function check(root, args = [], input, env = process.env) {
  return spawnSync(process.execPath, [qc, "check", ...args], { cwd: root, encoding: "utf8", input, env });
}

test("related receives committed and staged paths once, without unstaged or untracked files", (t) => {
  const root = fixture(t, { related: record });
  writeFileSync(path.join(root, "committed.mjs"), "export const value = 2;\n");
  git(root, "add", "committed.mjs");
  git(root, "commit", "-q", "-m", "test(qc): change shared module");
  const staged = "staged file; literal.mjs";
  writeFileSync(path.join(root, staged), "export {};\n");
  writeFileSync(path.join(root, "unstaged.mjs"), "export const unstaged = true;\n");
  writeFileSync(path.join(root, "untracked.mjs"), "export {};\n");
  git(root, "add", staged, "committed.mjs");
  const run = check(root);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "args.json"), "utf8")), ["committed.mjs", staged]);
  assert.equal(run.stdout.split("\n").filter((line) => line.startsWith("RUN  ")).length, 1);
});

test("a failing related command streams output and preserves its exit code", (t) => {
  const root = fixture(t, { related: node('console.log("related output"); console.error("related error"); process.exit(7)'), commands: [record] });
  writeFileSync(path.join(root, "changed.mjs"), "export {};\n");
  git(root, "add", "changed.mjs");
  const run = check(root);
  assert.equal(run.status, 7, run.stderr);
  assert.match(run.stdout, /related output/);
  assert.match(run.stderr, /related error/);
  assert.equal(existsSync(path.join(root, "args.json")), false);
});

test("default check settings run no extra command or merge-base lookup", (t) => {
  const root = fixture(t, { related: null, commands: [], base: "missing-ref" });
  const run = check(root);
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout + run.stderr, /RUN  |merge base/);
});

test("related skips an empty diff while repository commands run without file arguments", (t) => {
  const root = fixture(t, { related: node("process.exit(9)"), commands: [record] });
  const run = check(root);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "args.json"), "utf8")), []);
  assert.equal(run.stdout.split("\n").filter((line) => line.startsWith("RUN  ")).length, 1);
});

test("no merge base prints one reason and runs related without file arguments", (t) => {
  const root = fixture(t, { related: record, base: "missing-ref" });
  const run = check(root);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "args.json"), "utf8")), []);
  const reasons = (run.stdout + run.stderr).split("\n").filter((line) => /merge base/.test(line));
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /missing-ref/);
});

test("repository commands run in order and stop with the failing command's exit code", (t) => {
  const root = fixture(t, { commands: [node('console.log("first command")'), node("process.exit(8)"), record] });
  const run = check(root);
  assert.equal(run.status, 8, run.stderr);
  assert.match(run.stdout, /first command/);
  assert.equal(run.stdout.split("\n").filter((line) => line.startsWith("RUN  ")).length, 2);
  assert.equal(existsSync(path.join(root, "args.json")), false);
});

test("commands resolve PATH shims and preserve literal arguments and exit codes", (t) => {
  const bin = mkdtempSync(path.join(tmpdir(), "qc command shims "));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const source = 'require("node:fs").writeFileSync("args.json", JSON.stringify(process.argv.slice(3))); console.log("shim output"); process.exit(Number(process.argv[2]));\n';
  if (process.platform === "win32") {
    writeFileSync(path.join(bin, "shim.cjs"), source);
    writeFileSync(path.join(bin, "qc-command-shim.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0shim.cjs" %*\r\nexit /b %errorlevel%\r\n`);
  } else {
    writeFileSync(path.join(bin, "qc-command-shim"), `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
  env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
  for (const code of [0, 6]) {
    const root = fixture(t, { commands: [`qc-command-shim ${code} "literal && $HOME $(echo hi)" "" escaped\\ space`] });
    const run = check(root, [], undefined, env);
    assert.equal(run.status, code, run.stderr);
    assert.match(run.stdout, /shim output/);
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, "args.json"), "utf8")), ["literal && $HOME $(echo hi)", "", "escaped space"]);
  }
});

test("a failed architecture check prevents repository commands", (t) => {
  const root = fixture(t, { related: record, commands: [record] });
  const config = JSON.parse(readFileSync(path.join(root, "qc.config.json"), "utf8"));
  config.featureRoots = ["missing-root"];
  writeFileSync(path.join(root, "qc.config.json"), JSON.stringify(config));
  const run = check(root);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /unfound-root/);
  assert.equal(existsSync(path.join(root, "args.json")), false);
});

test("a missing command fails the check", (t) => {
  const root = fixture(t, { commands: ["qc-missing-command-170"] });
  const run = check(root);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /qc-missing-command-170/);
});

test("an empty explicit file list still runs repository commands", (t) => {
  const root = fixture(t, { commands: [record] });
  const run = check(root, ["--files-from", "-"], "");
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "args.json"), "utf8")), []);
});

test("quoted arguments and shell syntax reach the command as literal values", (t) => {
  const root = fixture(t, { commands: [`${record} "literal && $HOME $(echo hi)" "" escaped\\ space`] });
  const run = check(root);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "args.json"), "utf8")), ["literal && $HOME $(echo hi)", "", "escaped space"]);
});

test("double quotes and escaped quotes preserve inline node source", (t) => {
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.stdout.write("quoted output")')}`;
  const root = fixture(t, { commands: [command] });
  const run = check(root);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /quoted output/);
});

test("an unterminated quote fails the check", (t) => {
  const root = fixture(t, { commands: ['node "unterminated'] });
  const run = check(root);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /quote/i);
});

test("related uses the merge base instead of changes on the base branch", (t) => {
  const root = fixture(t, { related: record });
  writeFileSync(path.join(root, "feature.mjs"), "export {};\n");
  git(root, "add", "feature.mjs");
  git(root, "commit", "-q", "-m", "test(qc): change feature");
  git(root, "checkout", "-q", "main");
  writeFileSync(path.join(root, "base-only.mjs"), "export {};\n");
  git(root, "add", "base-only.mjs");
  git(root, "commit", "-q", "-m", "test(qc): advance base");
  git(root, "checkout", "-q", "feat/170-related");
  const run = check(root);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "args.json"), "utf8")), ["feature.mjs"]);
});

test("related excludes staged deletions and receives the new path of a staged rename", (t) => {
  const root = fixture(t, { related: record });
  git(root, "rm", "committed.mjs");
  git(root, "mv", "unstaged.mjs", "renamed file.mjs");
  const run = check(root);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "args.json"), "utf8")), ["renamed file.mjs"]);
});
