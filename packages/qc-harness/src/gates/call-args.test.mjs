import test from "node:test";
import assert from "node:assert/strict";
import { argumentSpans, callArguments } from "./call-args.mjs";

test("argumentSpans marks where each top-level argument sits", () => {
  const source = "f(a, [1, 2], { b: (c, d) }, )";
  const spans = argumentSpans(source, 1);
  assert.deepEqual(
    spans.map(({ start, end }) => source.slice(start, end)),
    ["a", " [1, 2]", " { b: (c, d) }", " "],
  );
});

test("callArguments reads the same arguments as the spans", () => {
  assert.deepEqual(callArguments("f(a, g(b, c))", 1), ["a", " g(b, c)"]);
  assert.deepEqual(callArguments("f()", 1), [""]);
});

test("a call that never closes gives the arguments that did close", () => {
  assert.deepEqual(callArguments("f(a, b", 1), ["a"]);
});
