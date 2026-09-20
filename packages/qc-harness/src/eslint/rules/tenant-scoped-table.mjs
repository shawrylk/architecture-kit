// Tenant isolation is the security model. docs/architecture.md.
// The partition-key index the database requires is the one exception.

import { optionsOf, schemaOf } from "../options.mjs";

const DEFAULT_COLUMN = "tenantId";
const DEFAULT_TABLE_FACTORY = "pgTable";
const DEFAULT_INDEX_FACTORY = "index";
const DEFAULT_EXEMPT = "partition";

export default {
  meta: {
    type: "problem",
    docs: { description: "every business table carries the tenant column" },
    schema: schemaOf({
      column: { type: "string" },
      tableFactory: { type: "string" },
      indexFactory: { type: "string" },
      exemptIndex: { type: "string" },
    }),
    messages: {
      missing: "Table '{{table}}' has no {{column}} column.",
      indexOrder: "Composite index '{{index}}' must lead with {{column}}.",
    },
  },
  create(context) {
    const options = optionsOf(context);
    const column = options.column ?? DEFAULT_COLUMN;
    const tableFactory = options.tableFactory ?? DEFAULT_TABLE_FACTORY;
    const indexFactory = options.indexFactory ?? DEFAULT_INDEX_FACTORY;
    const exemptIndex = new RegExp(options.exemptIndex ?? DEFAULT_EXEMPT, "i");

    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== tableFactory) return;
        const columns = node.arguments[1];
        if (!columns || columns.type !== "ObjectExpression") return;
        const tableArg = node.arguments[0];
        const table = tableArg && tableArg.type === "Literal" ? String(tableArg.value) : "table";
        const hasTenant = columns.properties.some(
          (property) =>
            property.type === "Property" &&
            property.key.type === "Identifier" &&
            property.key.name === column,
        );
        if (!hasTenant) {
          context.report({ node, messageId: "missing", data: { table, column } });
        }
      },
      "CallExpression > MemberExpression > CallExpression"(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== indexFactory) return;
        const parent = node.parent;
        if (parent.type !== "MemberExpression" || parent.property.type !== "Identifier") return;
        if (parent.property.name !== "on") return;
        const nameArg = node.arguments[0];
        const name = nameArg && nameArg.type === "Literal" ? String(nameArg.value) : "";
        if (exemptIndex.test(name)) return;
        const call = parent.parent;
        if (call.type !== "CallExpression" || call.arguments.length < 2) return;
        const first = call.arguments[0];
        const leadsWithTenant =
          first.type === "MemberExpression" &&
          first.property.type === "Identifier" &&
          first.property.name === column;
        if (!leadsWithTenant) {
          context.report({ node: call, messageId: "indexOrder", data: { index: name || "index", column } });
        }
      },
    };
  },
};
