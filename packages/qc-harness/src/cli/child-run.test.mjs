import { strict as assert } from "node:assert";
import { test } from "node:test";
import { commandLine, runInShell, splitAtDashes } from "./child-run.mjs";

test("a word with a space or a quote is quoted, and a leading -- is dropped", () => {
  assert.equal(commandLine(["--", "pnpm", "vitest", "run", "a b.test.ts", 'say "hi"']), 'pnpm vitest run "a b.test.ts" "say \\"hi\\""');
});

test("argv splits at its first --", () => {
  assert.deepEqual(splitAtDashes(["--port", "auto", "--", "pnpm", "--", "x"]), { flags: ["--port", "auto"], command: ["pnpm", "--", "x"] });
  assert.deepEqual(splitAtDashes(["--status"]), { flags: ["--status"], command: [] });
});

test("the shell runs the command and returns its exit code", async () => {
  assert.equal(await runInShell(`"${process.execPath}" -e "process.exit(3)"`), 3);
});
