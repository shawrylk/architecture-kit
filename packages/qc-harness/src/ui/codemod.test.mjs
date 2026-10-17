import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  arbitraryTokens,
  codemodSource,
  parseMap,
  rewriteToken,
  splitToken,
  suggest,
  themeVariables,
} from "./codemod.mjs";
import { loadTypeScript } from "./typescript.mjs";

const ts = loadTypeScript();
const CALLEES = ["cn", "clsx", "cva", "twMerge"];
const MAP = { "text-[11px]": "text-2xs", "rounded-[4px]": "rounded-sm" };
const run = (text, map = MAP) => codemodSource(ts, "a.tsx", text, map, CALLEES);

test("splitToken finds the variant prefix, the important modifier and the core, ignoring a colon in brackets", () => {
  assert.deepEqual(splitToken("md:hover:!text-[11px]"), { prefix: "md:hover:", lead: "!", trail: "", core: "text-[11px]" });
  assert.deepEqual(splitToken("dark:text-[11px]!"), { prefix: "dark:", lead: "", trail: "!", core: "text-[11px]" });
  assert.deepEqual(splitToken("[&:hover]:p-[4px]"), { prefix: "[&:hover]:", lead: "", trail: "", core: "p-[4px]" });
  assert.deepEqual(splitToken("data-[state=open]:bg-[url(a:b)]"), { prefix: "data-[state=open]:", lead: "", trail: "", core: "bg-[url(a:b)]" });
});

test("a whole token is rewritten and its variant chain and ! modifier are kept", () => {
  assert.equal(rewriteToken("text-[11px]", MAP), "text-2xs");
  assert.equal(rewriteToken("md:hover:dark:text-[11px]", MAP), "md:hover:dark:text-2xs");
  assert.equal(rewriteToken("!rounded-[4px]", MAP), "!rounded-sm");
  assert.equal(rewriteToken("sm:rounded-[4px]!", MAP), "sm:rounded-sm!");
  assert.equal(rewriteToken("flex", MAP), "flex");
});

test("a token that only starts with a mapped token, or holds one, stays", () => {
  assert.equal(rewriteToken("text-[11px]/50", MAP), "text-[11px]/50");
  assert.equal(rewriteToken("text-[11px]-x", MAP), "text-[11px]-x");
  assert.equal(rewriteToken("my-text-[11px]", MAP), "my-text-[11px]");
  assert.equal(rewriteToken("text-[11px]", { "text-[11]": "x" }), "text-[11px]");
});

test("a replacement of several tokens keeps the prefix on each", () => {
  assert.equal(rewriteToken("md:text-[11px]", { "text-[11px]": "text-xs leading-4" }), "md:text-xs md:leading-4");
});

test("a className attribute string is rewritten by range and the rest of the file is untouched", () => {
  const text = `export const A = () => (\n  <div   className="flex  text-[11px] md:rounded-[4px]"  id="x">\n    text-[11px]\n  </div>\n);\n`;
  const out = run(text);
  assert.equal(out.count, 2);
  assert.equal(out.text, text.replace("text-[11px] md:rounded-[4px]", "text-2xs md:rounded-sm"));
});

test("a cn call, a cva object and a clsx key are rewritten, and a string elsewhere is not", () => {
  const text = [
    `const a = cn("text-[11px] p-2", cond && "!rounded-[4px]", { "rounded-[4px]": on });`,
    `const v = cva("text-[11px]", { variants: { size: { sm: "rounded-[4px]" } } });`,
    `const label = "text-[11px]";`,
    `const b = other("text-[11px]");`,
  ].join("\n");
  const out = run(text);
  assert.equal(out.count, 5);
  assert.equal(
    out.text,
    [
      `const a = cn("text-2xs p-2", cond && "!rounded-sm", { "rounded-sm": on });`,
      `const v = cva("text-2xs", { variants: { size: { sm: "rounded-sm" } } });`,
      `const label = "text-[11px]";`,
      `const b = other("text-[11px]");`,
    ].join("\n"),
  );
});

test("a string that is not class text stays, and a real class beside it changes", () => {
  const map = { shadow: "shadow-sm" };
  const text = [
    `const v = cva("p-1", {`,
    `  variants: { elevation: { shadow: "shadow" } },`,
    `  compoundVariants: [{ elevation: "shadow", class: "p-3" }],`,
    `  defaultVariants: { elevation: "shadow" },`,
    `});`,
    `const a = cn(e === "shadow" && "p-2");`,
    `const b = cn(lookup("shadow"));`,
    `const c = cn(on ? "shadow" : "p-2", list.includes("shadow") || "shadow", ["shadow"], { "shadow": on });`,
  ].join("\n");
  const out = run(text, map);
  assert.equal(
    out.text,
    [
      `const v = cva("p-1", {`,
      `  variants: { elevation: { shadow: "shadow-sm" } },`,
      `  compoundVariants: [{ elevation: "shadow", class: "p-3" }],`,
      `  defaultVariants: { elevation: "shadow" },`,
      `});`,
      `const a = cn(e === "shadow" && "p-2");`,
      `const b = cn(lookup("shadow"));`,
      `const c = cn(on ? "shadow-sm" : "p-2", list.includes("shadow") || "shadow-sm", ["shadow-sm"], { "shadow-sm": on });`,
    ].join("\n"),
  );
});

test("a compoundVariants class is rewritten and its selector is not", () => {
  const out = run(`const v = cva("a", { compoundVariants: [{ size: "text-[11px]", className: "text-[11px]" }] });`);
  assert.equal(out.text, `const v = cva("a", { compoundVariants: [{ size: "text-[11px]", className: "text-2xs" }] });`);
});

test("the static parts of a template literal are rewritten and a token cut by a substitution is not", () => {
  const out = run("const a = cn(`text-[11px] ${x} rounded-[4px] text-[11px]${y}`);");
  assert.equal(out.text, "const a = cn(`text-2xs ${x} rounded-sm text-[11px]${y}`);");
  assert.equal(out.count, 2);
});

test("a map is parsed from JSON and refuses a replacement that would break a string", () => {
  assert.deepEqual(parseMap('{"a-[1px]":"a-px"}'), { "a-[1px]": "a-px" });
  assert.throws(() => parseMap("[]"), /object/);
  assert.throws(() => parseMap('{"a":1}'), /string/);
  assert.throws(() => parseMap('{"a":"b\\"c"}'), /quote|backtick|backslash/);
  assert.throws(() => parseMap("{"), /JSON/);
});

test("arbitraryTokens counts each arbitrary-value core once per use, variants and ! stripped", () => {
  const counts = arbitraryTokens(ts, "a.tsx", `const a = <i className="text-[11px] md:text-[11px] !w-[10px] flex [mask-type:alpha] bg-[#fff]/50" />;`, CALLEES);
  assert.deepEqual([...counts], [["text-[11px]", 2], ["w-[10px]", 1], ["bg-[#fff]/50", 1]]);
});

test("themeVariables reads each @theme block and suggest matches a value, rem against px", () => {
  const css = `@import "tailwindcss";\n@theme inline {\n  --text-2xs: 0.6875rem;\n  --radius-sm: 4px;\n  --color-brand: #FFF;\n  --nested: { }\n}\n.x { --text-9: 9px; }\n`;
  const theme = themeVariables(css);
  assert.deepEqual(theme.map((v) => v.name), ["--text-2xs", "--radius-sm", "--color-brand"]);
  const lines = suggest(new Map([["text-[11px]", 14], ["rounded-[4px]", 3], ["bg-[#fff]", 2], ["w-[10px]", 1]]), theme);
  assert.deepEqual(lines, [
    { token: "text-[11px]", count: 14, variable: "--text-2xs", value: "0.6875rem" },
    { token: "rounded-[4px]", count: 3, variable: "--radius-sm", value: "4px" },
    { token: "bg-[#fff]", count: 2, variable: "--color-brand", value: "#FFF" },
    { token: "w-[10px]", count: 1, variable: null, value: null },
  ]);
});

test("without a theme the suggestion lists the tokens alone, by count then name", () => {
  const lines = suggest(new Map([["b-[1px]", 2], ["a-[1px]", 2], ["c-[1px]", 5]]), []);
  assert.deepEqual(lines.map((line) => line.token), ["c-[1px]", "a-[1px]", "b-[1px]"]);
});
