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

test("regex literals in interpolations preserve the remaining shell command", () => {
  assert.deepEqual(replCommands("$`echo ${/'/.test(\"\")}; git commit --no-verify`"),
    ["echo QC_VALUE; git commit --no-verify"]);
});

test("tools.Bash skips regex literals in property values", () => {
  assert.deepEqual(replCommands('tools.Bash({ description: /}/.source, command: "git commit --no-verify" })'),
    ["git commit --no-verify"]);
  assert.deepEqual(replCommands(String.raw`tools.Bash({ description: /[},'\/]*/gi.source, command: "git commit --no-verify" })`),
    ["git commit --no-verify"]);
});

test("division across a line end keeps the Bash command", () => {
  assert.deepEqual(replCommands('const timeoutMs = 120000; tools.Bash({ command: "git commit --no-verify", timeout: timeoutMs\n  / 2 });'),
    ["git commit --no-verify"]);
});

test("regex scanning follows expression starts and preserves division", () => {
  const expressions = [
    "(/'/)", "(0, /'/)", "value = /'/", "({ pattern: /'/ })", "[/'/]", "!/'/", "value && /'/",
    "value || /'/", "value ? /'/ : /}/", "(() => { /'/; })()", "(() => { {} /'/; })()",
    "(() => { value; /'/; })()", "(() => { return /'/; })()", "value\n/ 2",
    "(() => { return /* note */ /'/; })()", String.raw`/\/'[}]/gi`,
    "12 / 3", "(12) / 3", "values[0] / 3", "value / /* note */ 3", "value / /}/.source.length",
  ];
  for (const expression of expressions) {
    assert.deepEqual(replCommands('$`echo ${' + expression + '}; git commit --no-verify`'),
      ["echo QC_VALUE; git commit --no-verify"], expression);
    assert.deepEqual(replCommands(`tools.Bash({ description: ${expression}, command: "git commit --no-verify" })`),
      ["git commit --no-verify"], expression);
  }
});

test("line comments end at every JavaScript line terminator", () => {
  for (const lineEnd of ["\r", "\n", "\u2028", "\u2029"]) {
    assert.deepEqual(replCommands(`tools.Bash({ // note${lineEnd}command: "git commit --no-verify" })`),
      ["git commit --no-verify"], JSON.stringify(lineEnd));
    assert.deepEqual(replCommands('$`echo ${value // note' + lineEnd + '}; git commit --no-verify`'),
      ["echo QC_VALUE; git commit --no-verify"], JSON.stringify(lineEnd));
  }
});

test("string calls skip comments and whitespace around the argument", () => {
  assert.deepEqual(replCommands('$("git commit --no-verify" /* note */)'),
    ["git commit --no-verify"]);
  assert.deepEqual(replCommands('$( /* before */ // note\r "git commit --no-verify" // after\u2028 /* end */ )'),
    ["git commit --no-verify"]);
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
