import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classTokensOf } from "./class-sites.mjs";
import { loadTypeScript, parseSource } from "./typescript.mjs";

const ts = loadTypeScript();
const CALLEES = ["cn", "clsx", "cva", "twMerge"];
const tokens = (text) => classTokensOf(ts, parseSource(ts, "a.tsx", text), CALLEES).map((one) => one.text);

test("a className string, a className expression and a class attribute are sites", () => {
  assert.deepEqual(
    tokens(`const a = <div className="p-2 flex" class='x' title="not-a-class" />; const b = <p className={cond ? "m-1" : "m-2"} />;`),
    ["p-2", "flex", "x", "m-1", "m-2"],
  );
});

test("a string in a call to a class callee is a site, a string in another call is not", () => {
  assert.deepEqual(tokens(`const a = cn("p-2", cond && "m-1", { "b-1": on }); const b = other("p-9");`), ["p-2", "m-1", "b-1"]);
});

test("a cva call yields its base and its variant strings but not its variant names", () => {
  assert.deepEqual(
    tokens(`const v = cva("base-1", { variants: { size: { "sm": "text-xs", md: "text-sm" } }, defaultVariants: { size: "md" } });`),
    ["base-1", "text-xs", "text-sm", "md"],
  );
});

test("the static parts of a template literal are sites, and a token touching a substitution is skipped", () => {
  assert.deepEqual(tokens("const a = cn(`p-2 ${x} m-1 w-${n} flex`, `solo-1`);"), ["p-2", "m-1", "flex", "solo-1"]);
});

test("a string outside a class position and a type literal are not sites", () => {
  assert.deepEqual(tokens(`const label = "p-2"; type T = "m-1"; const c = <i data-x="w-1" />;`), []);
});

test("each token carries its source range, so an edit never reprints the file", () => {
  const text = `const a = <i className="aa  bb" />;`;
  const [first, second] = classTokensOf(ts, parseSource(ts, "a.tsx", text), CALLEES);
  assert.equal(text.slice(first.start, first.end), "aa");
  assert.equal(text.slice(second.start, second.end), "bb");
});
