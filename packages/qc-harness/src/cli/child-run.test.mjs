import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { commandLine, runInShell, splitAtDashes } from "./child-run.mjs";

test("each word is quoted for the shell of the platform, and a leading -- is dropped", () => {
  const words = ["--", "pnpm", "vitest", "run", "a b.test.ts", 'say "hi"'];
  assert.equal(commandLine(words, "win32"), 'pnpm vitest run "a b.test.ts" "say \\"hi\\""');
  assert.equal(commandLine(words, "linux"), `pnpm vitest run 'a b.test.ts' 'say "hi"'`);
  assert.equal(commandLine(["bash", "-c", "echo $HOME\necho it's", ""], "linux"), `bash -c 'echo $HOME\necho it'\\''s' ''`);
  assert.throws(() => commandLine(["bash", "-c", "a\nb"], "win32"), /line break/);
});

test("the shell hands each word to the command unchanged", async () => {
  const word = process.platform === "win32" ? `one 'two' $HOME \`x\` "q"` : `line one\nline 'two' $HOME \`x\` "q"`;
  const out = path.join(mkdtempSync(path.join(tmpdir(), "child-run-")), "word.txt");
  const script = `require("node:fs").writeFileSync(process.argv[2], process.argv[1])`;
  assert.equal(await runInShell(commandLine([process.execPath, "-e", script, word, out])), 0);
  assert.equal(readFileSync(out, "utf8"), word);
});

test("argv splits at its first --", () => {
  assert.deepEqual(splitAtDashes(["--port", "auto", "--", "pnpm", "--", "x"]), { flags: ["--port", "auto"], command: ["pnpm", "--", "x"] });
  assert.deepEqual(splitAtDashes(["--status"]), { flags: ["--status"], command: [] });
});

test("the shell runs the command and returns its exit code", async () => {
  assert.equal(await runInShell(`"${process.execPath}" -e "process.exit(3)"`), 3);
});
