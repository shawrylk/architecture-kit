import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { load } from "../config.mjs";
import { runCheck } from "./check.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
const REGISTRY = "quality-thresholds.json";
const registry = (gates) => `${JSON.stringify({ gates }, null, 2)}\n`;
const FILELENGTH = { filelength: { value: 500, unit: "lines", comparator: "max" } };

function write(dir, files) {
  for (const [rel, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), contents);
  }
}

/** A repository whose `main` holds the registry, checked out on a branch `feat`. One per case. */
function repo({ base = "main", commit = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "qc-ratchet-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "qc");
  git(dir, "config", "user.email", "qc@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  write(dir, { "qc.config.json": JSON.stringify({ featureRoots: [], ratchet: { base } }), [REGISTRY]: registry(FILELENGTH) });
  if (!commit) return dir;
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", "feat");
  return dir;
}

async function ratchet(dir) {
  const { problems, lines } = await runCheck(load(dir));
  return {
    loosened: problems.filter((problem) => problem.rule === "loosened-threshold"),
    line: lines.find((line) => line.includes("ratchet")),
  };
}

test("a max that rises from 500 to 550 fails", async () => {
  const dir = repo();
  write(dir, { [REGISTRY]: registry({ filelength: { ...FILELENGTH.filelength, value: 550 } }) });
  const { loosened } = await ratchet(dir);
  assert.equal(loosened.length, 1);
  assert.match(loosened[0].detail, /filelength/);
});

test("the same rise passes with a committed ADR that names the key", async () => {
  const dir = repo();
  write(dir, {
    [REGISTRY]: registry({ filelength: { ...FILELENGTH.filelength, value: 550 } }),
    "docs/decisions/0002-longer-files.md": "# Longer files\n\n`filelength` rises to 550: the parser needs one file.\n",
  });
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "loosen");
  assert.deepEqual((await ratchet(dir)).loosened, []);
});

test("a tightening passes", async () => {
  const dir = repo();
  write(dir, { [REGISTRY]: registry({ filelength: { ...FILELENGTH.filelength, value: 450 } }) });
  assert.deepEqual((await ratchet(dir)).loosened, []);
});

test("a new entry passes", async () => {
  const dir = repo();
  write(dir, { [REGISTRY]: registry({ ...FILELENGTH, nesting: { value: 9, unit: "count", comparator: "max" } }) });
  assert.deepEqual((await ratchet(dir)).loosened, []);
});

test("a base ref that does not exist skips with an OK line that says why", async () => {
  const dir = repo({ base: "origin/main" });
  write(dir, { [REGISTRY]: registry({ filelength: { ...FILELENGTH.filelength, value: 550 } }) });
  const { loosened, line } = await ratchet(dir);
  assert.deepEqual(loosened, []);
  assert.match(line, /^OK .*no ref 'origin\/main'/);
});

test("a repository with no commit yet skips with an OK line", async () => {
  const { loosened, line } = await ratchet(repo({ commit: false }));
  assert.deepEqual(loosened, []);
  assert.match(line, /^OK .*no commit/);
});
