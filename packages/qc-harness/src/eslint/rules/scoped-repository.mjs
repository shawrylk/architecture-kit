// A singleton repository captures the first request's tenant. docs/architecture.md.

import { optionsOf, schemaOf, suffixGroup } from "../options.mjs";

const DEFAULT_SUFFIXES = ["Repository", "Saga", "UnitOfWork", "UnitOfWorkFactory"];

export default {
  meta: {
    type: "problem",
    docs: { description: "repositories and sagas are scoped, never singleton" },
    schema: schemaOf({
      suffixes: { type: "array", items: { type: "string" } },
      lifetime: { type: "string" },
    }),
    messages: {
      singleton:
        "'{{name}}' must be .{{lifetime}}(). A singleton repository holds one tenant for the process lifetime — a cross-tenant leak.",
    },
  },
  create(context) {
    const options = optionsOf(context);
    const scopedName = suffixGroup(options.suffixes ?? DEFAULT_SUFFIXES);
    const lifetime = options.lifetime ?? "scoped";
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.property.type !== "Identifier" ||
          callee.property.name !== "singleton"
        ) {
          return;
        }
        const inner = callee.object;
        if (inner.type !== "CallExpression" || inner.arguments.length === 0) return;
        const arg = inner.arguments[0];
        if (arg.type === "Identifier" && scopedName.test(arg.name)) {
          context.report({ node, messageId: "singleton", data: { name: arg.name, lifetime } });
        }
      },
    };
  },
};
