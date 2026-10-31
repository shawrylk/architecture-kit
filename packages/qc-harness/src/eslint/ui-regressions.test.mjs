import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";
import parser from "@typescript-eslint/parser";
import { rules } from "./index.mjs";

function lint(rule, code, filename = "view.tsx") {
  return new Linter().verify(code, [{
    files: ["**/*.tsx", "**/*.ts"],
    languageOptions: { parser },
    plugins: { qc: { rules } },
    rules: { [`qc/${rule}`]: "error" },
  }], filename);
}

test("literal colors in text attributes pass", () => {
  const code = '<Input label="PR #186" title="Ticket #123" alt="Order #abc" value="#ffffff" />;';
  assert.deepEqual(lint("no-literal-color", code), []);
});

test("theme tokens pass while literal colors in a style binding fail", () => {
  assert.deepEqual(lint("no-literal-color", 'export const tokens = { background: "#ffffff", borderColor: "#abc" };', "theme.ts"), []);
  const messages = lint("no-literal-color", 'const styles = { borderColor: "#abc" }; <div style={styles} />;');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].messageId, "color");
});

test("local memo and forwardRef wrappers keep one component", () => {
  for (const wrapper of ["memo", "React.memo", "forwardRef", "React.forwardRef"]) {
    const code = `function ItemBase() { return <li />; } export const Item = ${wrapper}(ItemBase);`;
    assert.deepEqual(lint("one-component-per-file", code), [], wrapper);
  }
  assert.deepEqual(lint("one-component-per-file", 'const Item = memo(forwardRef(ItemBase)); function ItemBase() { return <li />; }'), []);
});

test("each component gets a report on its own declaration line", () => {
  const messages = lint("one-component-per-file", "const Added = () => <i />;\nfunction Existing() { return <li />; }\n");
  assert.deepEqual(messages.map(({ line, messageId }) => [line, messageId]), [[1, "multiple"], [2, "multiple"]]);
});
