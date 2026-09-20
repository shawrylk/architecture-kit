// Domain code throws a DomainError; one handler maps it. docs/architecture.md.

import { optionsOf, schemaOf, suffixGroup } from "../options.mjs";

const DEFAULT_SETTERS = ["status", "code", "statusCode"];

export default {
  meta: {
    type: "problem",
    docs: { description: "no hand-written HTTP status" },
    schema: schemaOf({ setters: { type: "array", items: { type: "string" } }, error: { type: "string" } }),
    messages: { literal: "Throw a {{error}}. One error handler owns the status mapping." },
  },
  create(context) {
    const options = optionsOf(context);
    const setters = new Set(options.setters ?? DEFAULT_SETTERS);
    const error = options.error ?? "DomainError";
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === "MemberExpression" &&
          callee.property.type === "Identifier" &&
          setters.has(callee.property.name) &&
          node.arguments.length === 1 &&
          node.arguments[0].type === "Literal" &&
          typeof node.arguments[0].value === "number"
        ) {
          context.report({ node, messageId: "literal", data: { error } });
        }
      },
    };
  },
};
