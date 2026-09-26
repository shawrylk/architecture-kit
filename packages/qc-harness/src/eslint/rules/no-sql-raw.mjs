// A query binds its values. sql.raw splices text into the statement unescaped. docs/architecture.md.

import { filenameOf, optionsOf, pathSuffix, schemaOf } from "../options.mjs";

function isRaw(node) {
  if (node.object.type !== "Identifier" || node.object.name !== "sql") return false;
  const property = node.property;
  if (!node.computed) return property.type === "Identifier" && property.name === "raw";
  return property.type === "Literal" && property.value === "raw";
}

export default {
  meta: {
    type: "problem",
    docs: { description: "a query binds its values; sql.raw is refused outside a reviewed file" },
    schema: schemaOf({ allow: { type: "array", items: { type: "string" } } }),
    messages: {
      raw: "sql.raw splices text into the statement unescaped: bind the value, or list this file in sqlRaw.allow after a review.",
    },
  },
  create(context) {
    const filename = filenameOf(context);
    if ((optionsOf(context).allow ?? []).some((path) => pathSuffix(path).test(filename))) return {};
    return {
      MemberExpression(node) {
        if (isRaw(node)) context.report({ node, messageId: "raw" });
      },
    };
  },
};
