// Keyset only; offset is never offered. docs/architecture.md.

import { optionsOf, schemaOf } from "../options.mjs";

const DEFAULT_BANNED = ["offset", "skip"];

export default {
  meta: {
    type: "problem",
    docs: { description: "keyset pagination only" },
    schema: schemaOf({ banned: { type: "array", items: { type: "string" } } }),
    messages: { offset: "'{{name}}' is offset pagination. Use a keyset cursor." },
  },
  create(context) {
    const banned = new Set(optionsOf(context).banned ?? DEFAULT_BANNED);
    return {
      MemberExpression(node) {
        if (node.property.type === "Identifier" && banned.has(node.property.name) && node.object.type !== "ThisExpression") {
          context.report({ node, messageId: "offset", data: { name: node.property.name } });
        }
      },
      Property(node) {
        if (node.key.type === "Identifier" && banned.has(node.key.name)) {
          context.report({ node, messageId: "offset", data: { name: node.key.name } });
        }
      },
    };
  },
};
