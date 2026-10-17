import { strict as assert } from "node:assert";
import path from "node:path";
import { test } from "node:test";
import { failedFiles, runRetryFailed } from "./retry-failed.mjs";

const ROOT = path.resolve("/repo");
const report = (...results) => JSON.stringify({ testResults: results.map(([name, status]) => ({ name: path.join(ROOT, name), status })) });

test("the failed files of a Jest or Vitest report are read relative to the root", () => {
  assert.deepEqual(failedFiles(report(["src/a.test.ts", "failed"], ["src/b.test.ts", "passed"]), ROOT), ["src/a.test.ts"]);
  assert.equal(failedFiles("not json", ROOT), null);
  assert.equal(failedFiles("{}", ROOT), null);
});

/** A runner that answers from a list of exit codes, and records each command. */
function scripted(codes, ran) {
  return async (command) => {
    ran.push(command);
    return codes.shift();
  };
}

const deps = (overrides) => ({ cwd: ROOT, env: {}, say: () => {}, remove: () => {}, ...overrides });

test("a run that fails in two test files reruns only those files once, and passes when the rerun passes", async () => {
  const ran = [];
  const code = await runRetryFailed(["--report", "r.json", "--rerun", "pnpm vitest run", "--", "pnpm", "check:local"], deps({
    run: scripted([1, 0], ran),
    read: () => report(["src/a.test.ts", "failed"], ["src/b.test.ts", "failed"]),
  }));
  assert.equal(code, 0);
  assert.deepEqual(ran, ["pnpm check:local", "pnpm vitest run src/a.test.ts src/b.test.ts"]);
});

test("a failure with no report, or with more failed files than the limit, is not rerun", async () => {
  const ran = [];
  const argv = ["--report", "r.json", "--rerun", "pnpm vitest run", "--max-files", "1", "--", "pnpm", "check:local"];
  assert.equal(await runRetryFailed(argv, deps({ run: scripted([3], ran), read: () => null })), 3);
  assert.equal(await runRetryFailed(argv, deps({ run: scripted([1], ran), read: () => report(["a.test.ts", "failed"], ["b.test.ts", "failed"]) })), 1);
  assert.deepEqual(ran, ["pnpm check:local", "pnpm check:local"]);
});

test("the report of an earlier run is removed before the command runs", async () => {
  const removed = [];
  await runRetryFailed(["--report", "r.json", "--rerun", "x", "--", "y"], deps({ run: async () => 0, read: () => null, remove: (file) => removed.push(file) }));
  assert.deepEqual(removed, [path.join(ROOT, "r.json")]);
});

test("a missing flag or command is a usage error", async () => {
  assert.equal(await runRetryFailed(["--", "pnpm", "test"], deps({ run: async () => 0, read: () => null })), 2);
});
