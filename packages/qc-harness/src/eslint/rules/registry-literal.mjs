// A number a registry owns has one home. Only the readers an entry names may hold it in code.

import { filenameOf, optionsOf, pathSuffix, schemaOf } from "../options.mjs";

const strings = { type: "array", items: { type: "string" } };

function isNumber(node) {
  if (!node) return false;
  if (node.type === "Literal") return typeof node.value === "number";
  if (node.type === "UnaryExpression") return node.operator === "-" && isNumber(node.argument);
  if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression") return isNumber(node.expression);
  return false;
}

function keyName(key) {
  if (key.type === "Identifier") return key.name;
  return key.type === "Literal" && typeof key.value === "string" ? key.value : null;
}

export default {
  meta: {
    type: "problem",
    docs: { description: "a number the registry owns is held only by the readers its entry names" },
    schema: schemaOf({
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: { key: { type: "string" }, names: strings, readers: strings },
          required: ["key", "names"],
          additionalProperties: false,
        },
      },
      values: {
        type: "array",
        items: {
          type: "object",
          properties: { key: { type: "string" }, registry: { type: "string" }, value: { type: "number" }, readers: strings },
          required: ["key", "registry", "value", "readers"],
          additionalProperties: false,
        },
      },
    }),
    messages: {
      restated: "'{{name}}' restates the registry entry '{{key}}': import the number from {{readers}}.",
      restatedValue: "{{value}} is the figure of the '{{key}}' entry of {{registry}}: import it from {{readers}}.",
      unread: "'{{name}}' restates the registry entry '{{key}}', which names no reader: read the number from the registry.",
    },
  },
  create(context) {
    const filename = filenameOf(context);
    const entries = (optionsOf(context).entries ?? [])
      .map((entry) => ({ ...entry, readers: entry.readers ?? [] }))
      .filter((entry) => !entry.readers.some((reader) => pathSuffix(reader).test(filename)))
      .map((entry) => ({ ...entry, patterns: entry.names.map((name) => new RegExp(`^(?:${name})$`, "i")) }));
    const values = (optionsOf(context).values ?? []).filter((entry) => !entry.readers.some((reader) => pathSuffix(reader).test(filename)));
    if (entries.length === 0 && values.length === 0) return {};
    function check(node, name, value) {
      if (!name || !isNumber(value)) return;
      const entry = entries.find((candidate) => candidate.patterns.some((pattern) => pattern.test(name)));
      if (!entry) return;
      const data = { name, key: entry.key, readers: entry.readers.join(", ") };
      context.report({ node, messageId: entry.readers.length > 0 ? "restated" : "unread", data });
    }
    // A key or a type position is no figure a reader would import.
    const isFigure = ({ parent }, node) =>
      !((parent.type === "Property" || parent.type === "PropertyDefinition") && parent.key === node) &&
      parent.type !== "TSLiteralType" &&
      parent.type !== "MemberExpression";
    return {
      Literal(node) {
        if (typeof node.value !== "number" || !isFigure(node, node)) return;
        const entry = values.find((candidate) => candidate.value === node.value);
        if (!entry) return;
        const data = { value: String(node.value), key: entry.key, registry: entry.registry, readers: entry.readers.join(", ") };
        context.report({ node, messageId: "restatedValue", data });
      },
      VariableDeclarator(node) {
        if (node.id.type === "Identifier") check(node, node.id.name, node.init);
      },
      Property(node) {
        if (!node.computed) check(node, keyName(node.key), node.value);
      },
      PropertyDefinition(node) {
        if (!node.computed) check(node, keyName(node.key), node.value);
      },
    };
  },
};
