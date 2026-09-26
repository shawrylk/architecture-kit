import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { repoFiles } from "./repo-files.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" });

function tree(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "qc-files-"));
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), contents);
  }
  return dir;
}

function checkout(files) {
  const dir = tree(files);
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

test("an untracked file under a path in .git/info/exclude is not listed", async () => {
  const dir = checkout({ "src/a.ts": "", ".gitnexus/meta.json": "{}" });
  writeFileSync(path.join(dir, ".git/info/exclude"), ".gitnexus/\n");
  assert.deepEqual(await repoFiles(dir), ["src/a.ts"]);
  rmSync(dir, { recursive: true, force: true });
});

test("a tracked file is listed, also under a folder that git ignores", async () => {
  const dir = checkout({ ".gitignore": "vendor/\n", "vendor/kept.ts": "", "vendor/loose.ts": "", "src/a.ts": "" });
  git(dir, "add", "-f", "vendor/kept.ts", "src/a.ts");
  assert.deepEqual(await repoFiles(dir), [".gitignore", "src/a.ts", "vendor/kept.ts"]);
  rmSync(dir, { recursive: true, force: true });
});

test("ignores drop a path at the root and below, as ESLint reads them", async () => {
  const dir = checkout({ "dist/a.js": "", "pkg/dist/b.js": "", "pkg/c.tsbuildinfo": "", "pkg/d.ts": "" });
  const ignores = ["**/dist/**", "**/*.tsbuildinfo"];
  assert.deepEqual(await repoFiles(dir, { ignores }), ["pkg/d.ts"]);
  rmSync(dir, { recursive: true, force: true });
});

test("pathspecs scope the listing to those files and folders, literally", async () => {
  const dir = checkout({ "a/[x].ts": "", "a/y.ts": "", "b/z.ts": "", "c.ts": "" });
  assert.deepEqual(await repoFiles(dir, { pathspecs: ["a/[x].ts", "b"] }), ["a/[x].ts", "b/z.ts"]);
  rmSync(dir, { recursive: true, force: true });
});

test("outside git, a walk lists every file and prunes an ignored folder", async () => {
  const dir = tree({ "src/a.ts": "", "node_modules/x/index.js": "", "b/c.md": "" });
  const ignores = ["**/node_modules/**"];
  assert.deepEqual(await repoFiles(dir, { ignores }), ["b/c.md", "src/a.ts"]);
  assert.deepEqual(await repoFiles(dir, { ignores, pathspecs: ["src", "b/c.md", "gone.ts"] }), ["b/c.md", "src/a.ts"]);
  rmSync(dir, { recursive: true, force: true });
});
