import test from "node:test";
import assert from "node:assert/strict";
import { RuleTester } from "eslint";
import rule from "./no-promise-then.mjs";

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2023, sourceType: "module" } });

test("an awaited promise passes, and a chained one fails", () => {
  tester.run("no-promise-then", rule, {
    valid: [
      { code: "async function f() { const a = await g(); return a; }" },
      { code: "async function f() { try { await g(); } catch (error) { report(error); } }" },
      // .finally carries no value and has no await form, so it is left alone.
      { code: "async function f() { await g().finally(() => close()); }" },
      // A member named `then` with no callback is some other api borrowing the word.
      { code: "const when = schedule.then;" },
      // A computed key that is not a literal cannot be read, so it is left alone.
      { code: "async function f() { await queue[key](handler); }" },
    ],
    invalid: [
      {
        code: "function f() { return g().then((value) => value + 1); }",
        errors: [{ messageId: "chained", data: { method: "then" } }],
      },
      {
        code: "function f() { return g().catch(handle); }",
        errors: [{ messageId: "chained", data: { method: "catch" } }],
      },
      {
        code: "function f() { return g().then(function (v) { return v; }); }",
        errors: [{ messageId: "chained" }],
      },
      {
        code: "function f() { return g()[\"then\"](h); }",
        errors: [{ messageId: "chained", data: { method: "then" } }],
      },
      {
        code: "function f() { return g()?.then(h); }",
        errors: [{ messageId: "chained" }],
      },
    ],
  });
});

test("a module named in `allow` may still chain", () => {
  tester.run("no-promise-then", rule, {
    valid: [
      {
        code: "function f() { return g().then(h); }",
        filename: "/repo/packages/kernel/src/abortable.ts",
        options: [{ allow: ["packages/kernel/src/abortable.ts"] }],
      },
    ],
    invalid: [
      {
        code: "function f() { return g().then(h); }",
        filename: "/repo/frontend/src/features/photos/slices/list-photos.ts",
        options: [{ allow: ["packages/kernel/src/abortable.ts"] }],
        errors: [{ messageId: "chained" }],
      },
    ],
  });
});
