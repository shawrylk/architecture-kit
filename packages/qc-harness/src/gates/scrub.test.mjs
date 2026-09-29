import test from "node:test";
import assert from "node:assert/strict";
import { scrub } from "./scrub.mjs";

test("a comment is blanked, and every offset and newline stays", () => {
  const source = "a(); // b()\n/* c()\n d() */ e();";
  const code = scrub(source, false);
  assert.equal(code.length, source.length);
  assert.equal(code.split("\n").length, source.split("\n").length);
  assert.ok(!code.includes("b()") && !code.includes("c()") && !code.includes("d()"));
  assert.ok(code.includes("a();") && code.includes("e();"));
});

test("a string is blanked, or kept when keepStrings is set", () => {
  const source = `f("x()", 'y()');`;
  assert.ok(!scrub(source, false).includes("x()"));
  assert.equal(scrub(source, true), source);
});

test("the text of a template goes and the code in its expression stays", () => {
  const code = scrub("`hidden() ${shown()} hidden()`", false);
  assert.ok(code.includes("shown()"));
  assert.ok(!code.includes("hidden()"));
});

test("a quote inside a comment or a regular expression starts no string", () => {
  const code = scrub("// it's\nkept(); const r = /'/; alsoKept();", false);
  assert.ok(code.includes("kept();") && code.includes("alsoKept();"));
});
