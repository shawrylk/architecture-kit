import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ignoredPaths } from "./ignored-paths.mjs";

/** A checkout that ignores `*.local.json` and tracks one file whose name matches that pattern. */
function checkout() {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-ignored-")));
  const git = (...args) => execFileSync("git", args, { cwd: base, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(base, ".gitignore"), "*.local.json\n");
  writeFileSync(path.join(base, "tracked.local.json"), "{}");
  git("add", ".gitignore");
  git("add", "-f", "tracked.local.json");
  git("-c", "user.name=qc", "-c", "user.email=qc@example.com", "commit", "-q", "-m", "init");
  return { root: base, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("the ignored subset of the paths comes back, in one call", async (t) => {
  const repo = checkout();
  t.after(repo.cleanup);
  const ignored = await ignoredPaths(repo.root, [".claude/settings.local.json", "src/a.ts", "notes.local.json"]);
  assert.deepEqual([...ignored].sort(), [".claude/settings.local.json", "notes.local.json"]);
});

test("a tracked file is never ignored, even when its name matches an ignore pattern", async (t) => {
  const repo = checkout();
  t.after(repo.cleanup);
  assert.equal((await ignoredPaths(repo.root, ["tracked.local.json"])).size, 0);
});

test("no path ignored, no paths, or no checkout is the empty set", async (t) => {
  const repo = checkout();
  t.after(repo.cleanup);
  assert.equal((await ignoredPaths(repo.root, ["src/a.ts"])).size, 0);
  assert.equal((await ignoredPaths(repo.root, [])).size, 0);
  const outside = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-no-checkout-")));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(path.join(outside, "sub"));
  assert.equal((await ignoredPaths(path.join(outside, "sub"), ["a.local.json"])).size, 0);
});
