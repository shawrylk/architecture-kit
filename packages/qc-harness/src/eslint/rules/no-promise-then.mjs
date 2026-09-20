// A promise is awaited. `.finally()` carries no value and has no await form, so it is left alone.

import { filenameOf, optionsOf, pathSuffix, schemaOf } from "../options.mjs";

const DEFAULT_METHODS = ["then", "catch"];

export default {
  meta: {
    type: "problem",
    docs: { description: "a promise is awaited, never continued with .then() or .catch()" },
    schema: schemaOf({
      methods: { type: "array", items: { type: "string" } },
      allow: { type: "array", items: { type: "string" } },
    }),
    messages: {
      chained: "Await the promise instead of chaining .{{method}}(). Use try/catch for the failure path.",
    },
  },
  create(context) {
    const options = optionsOf(context);
    const methods = options.methods ?? DEFAULT_METHODS;
    const allowed = (options.allow ?? []).some((file) => pathSuffix(file).test(filenameOf(context)));
    if (allowed) return {};
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        // `p["then"](fn)` is `p.then(fn)` spelled to evade a rule that only reads dot access.
        const name = callee.computed
          ? (typeof callee.property.value === "string" ? callee.property.value : undefined)
          : callee.property.type === "Identifier"
            ? callee.property.name
            : undefined;
        if (name === undefined || !methods.includes(name)) return;
        // `x.catch` with no callback is some other api borrowing the name.
        const [first] = node.arguments;
        if (first === undefined) return;
        if (first.type !== "ArrowFunctionExpression" && first.type !== "FunctionExpression" && first.type !== "Identifier") return;
        context.report({ node: callee.property, messageId: "chained", data: { method: name } });
      },
    };
  },
};
