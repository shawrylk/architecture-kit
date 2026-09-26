import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkoutDirs, gitCall, isReadOnly, mayWrite, segmentsOf } from "./shell-command.mjs";

const wordsOf = (command) => segmentsOf(command).map((segment) => segment.words);

test("a command splits on unquoted separators, and a quoted separator stays in its word", () => {
  assert.deepEqual(wordsOf(`git add -A && git commit -m "a; b && c" | cat; echo x || true`), [
    ["git", "add", "-A"],
    ["git", "commit", "-m", "a; b && c"],
    ["cat"],
    ["echo", "x"],
    ["true"],
  ]);
});

test("a heredoc body belongs to its command, not to new segments", () => {
  const command = "git commit -F - <<'EOF'\nsubject; with && tokens | here\n\nbody line\nEOF\ngit push";
  assert.deepEqual(wordsOf(command), [["git", "commit", "-F", "-"], ["git", "push"]]);
});

test("a heredoc inside a quoted command substitution stays one word", () => {
  const command = `git commit -m "$(cat <<'EOF'\nsubject; don't split\nEOF\n)"`;
  assert.equal(segmentsOf(command).length, 1);
});

test("a redirect target is recorded apart from the words, and a descriptor copy is not a target", () => {
  const [segment] = segmentsOf("echo x > out.txt 2>/dev/null");
  assert.deepEqual(segment.words, ["echo", "x"]);
  assert.deepEqual(segment.redirects, ["out.txt", "/dev/null"]);
  assert.deepEqual(segmentsOf("npm test 2>&1")[0].redirects, []);
  assert.deepEqual(segmentsOf("cat log >> all.log")[0].redirects, ["all.log"]);
});

test("a git call names its subcommand and every -C directory", () => {
  const [segment] = segmentsOf(`GIT_PAGER=cat git -C "C:/a b" -c core.x=y --no-pager commit -m x`);
  assert.deepEqual(gitCall(segment), { sub: "commit", dirs: ["C:/a b"] });
  assert.equal(gitCall(segmentsOf("gitk --all")[0]), null);
});

test("a backslash inside double quotes stays, unless it escapes a quote, a dollar, or itself", () => {
  const [segment] = segmentsOf(String.raw`git -C "C:\Users\me\wt" commit -m "say \"hi\" for \$5"`);
  assert.deepEqual(segment.words.slice(2), [String.raw`C:\Users\me\wt`, "commit", "-m", 'say "hi" for $5']);
});

test("a read-only command is one whose every segment reads", () => {
  for (const command of [
    "ls -la",
    "cat a.txt | grep b",
    "git status --porcelain",
    "git diff HEAD~1 -- src",
    "rg foo src",
    "sed -n '1,5p' file.ts",
    "head -5 f 2>/dev/null",
    "cd /repo && git log --oneline 2>&1 | tail -3",
  ]) {
    assert.equal(mayWrite(command), false, command);
  }
});

test("any segment that can write makes the command a possible write", () => {
  for (const command of [
    "sed -i 's/a/b/' f.ts",
    "sed -ni.bak 's/a/b/p' f.ts",
    "echo x > f.ts",
    "node scripts/codemod.mjs",
    "python x.py",
    "mv a b",
    "cp a b",
    "rm a",
    "git checkout main -- src",
    "pnpm codegen",
    "npx prettier --write .",
    "ls && tee out.txt",
    "touch f",
    "sort -o out.txt in.txt",
    "uniq in.txt out.txt",
  ]) {
    assert.equal(mayWrite(command), true, command);
  }
});

test("isReadOnly judges one segment", () => {
  assert.equal(isReadOnly(segmentsOf("grep -rn x src")[0]), true);
  assert.equal(isReadOnly(segmentsOf("grep -rn x src > hits.txt")[0]), false);
});

test("the checkout directories are every cd target and every git -C directory, in order", () => {
  assert.deepEqual(checkoutDirs(`cd /repo/a && git -C "../b c" status; git -C /repo/d commit -m x`), [
    "/repo/a",
    "../b c",
    "/repo/d",
  ]);
  assert.deepEqual(checkoutDirs("ls"), []);
});
