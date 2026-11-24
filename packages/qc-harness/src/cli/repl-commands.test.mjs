import { strict as assert } from "node:assert";
import { test } from "node:test";
import { replCommands } from "./repl-commands.mjs";

test("reads tagged templates, string calls, and tools.Bash command literals in source order", () => {
  assert.deepEqual(replCommands('await $`git status`; $("git log"); tools.Bash({ command: \'git diff\' });'),
    ["git status", "git log", "git diff"]);
  assert.deepEqual(replCommands("$( 'git status' ); tools.Bash({ timeout: 1000, command: \"git log\", cwd: dir });"),
    ["git status", "git log"]);
});

test("replaces interpolation values with a shell word", () => {
  assert.deepEqual(replCommands('await $`git commit -m ${message} ${options.flag}`'),
    ["git commit -m QC_VALUE QC_VALUE"]);
  assert.deepEqual(replCommands('$`echo ${ { a: { b: "}" } } } done`'), ["echo QC_VALUE done"]);
});

test("decodes escaped delimiters and string literal escapes", () => {
  assert.deepEqual(replCommands('$`echo \\`hello\\` \\${value}`'), ['echo `hello` ${value}']);
  assert.deepEqual(replCommands('$("git\\x20commit\\u0020--no-verify\\n"); $(\'echo \\\'hello\\\'\');'),
    ["git commit --no-verify\n", "echo 'hello'"]);
});

test("balances nested templates, braces, comments, and quotes inside values", () => {
  assert.deepEqual(replCommands('$`echo ${`nested ${ {value: "}"} }`} tail`'), ["echo QC_VALUE tail"]);
  assert.deepEqual(replCommands('$`echo ${fn(/* } */ "}", \'{\', {value: `x${1}`})} tail`'), ["echo QC_VALUE tail"]);
  assert.deepEqual(replCommands('$`echo ${await $`git status`} tail`'), ["echo QC_VALUE tail", "git status"]);
});

test("reads two commands and retains templates inside comments and strings", () => {
  assert.deepEqual(replCommands('await $`git status`; await $`git commit --no-verify`;'),
    ["git status", "git commit --no-verify"]);
  assert.deepEqual(replCommands('// $`git commit --no-verify`\nconst text = "$`gh pr merge 1`";'),
    ["git commit --no-verify", "gh pr merge 1"]);
});

test("reads only the three literal forms", () => {
  for (const code of ['', 'const value = 1;', '$(command)', 'tools.Bash({ command })',
    'tools.Bash({ command: getCommand() })', 'other.Bash({ command: "git status" })',
    'shell`git status`', 'shell$("git status")', 'tools.Bash({ other: "git status" })']) {
    assert.deepEqual(replCommands(code), [], code);
  }
});

test("a malformed form preserves commands before and after it", () => {
  assert.deepEqual(replCommands('$`git commit --no-verify`; // $("unterminated'),
    ["git commit --no-verify"]);
  assert.deepEqual(replCommands('$("bad\\xZZ"); $`git commit --no-verify`'),
    ["git commit --no-verify"]);
  assert.deepEqual(replCommands('tools.Bash({ command: "unterminated }); $`git commit --no-verify`'),
    ["git commit --no-verify"]);
});

test("tools.Bash skips comments while scanning properties", () => {
  assert.deepEqual(replCommands('tools.Bash({ /* ignored, command: "fake" */ command: "git commit --no-verify" })'),
    ["git commit --no-verify"]);
  assert.deepEqual(replCommands('tools.Bash({ timeout: 1000, // ignored, command: "fake"\n command /* key */ : /* value */ "git commit --no-verify" /* end */ })'),
    ["git commit --no-verify"]);
  assert.deepEqual(replCommands('tools.Bash({ timeout: 1000 /* comma, command: "fake" */, command: "git status" })'),
    ["git status"]);
});

test("tools.Bash reads single- and double-quoted command keys", () => {
  for (const key of ['"command"', "'command'"]) {
    assert.deepEqual(replCommands(`tools.Bash({ ${key}: "git commit --no-verify" })`),
      ["git commit --no-verify"]);
  }
});

test("tools.Bash returns every literal value of duplicate command keys", () => {
  assert.deepEqual(replCommands('tools.Bash({ command: "git status", command: "git commit --no-verify" })'),
    ["git status", "git commit --no-verify"]);
  assert.deepEqual(replCommands('tools.Bash({ command: getCommand(), "command": "git status", nested: { command: "fake" }, \'command\': "git commit --no-verify" })'),
    ["git status", "git commit --no-verify"]);
});

test("an incomplete form contributes no command", () => {
  for (const code of ['$`unterminated', '$`echo ${value`', '$("unterminated)',
    'tools.Bash({ command: "unterminated })', '$("bad\\xZZ")']) {
    assert.deepEqual(replCommands(code), [], code);
  }
  assert.deepEqual(replCommands('$`git status`; $`unterminated'), ["git status"]);
  assert.deepEqual(replCommands(null), []);
});
