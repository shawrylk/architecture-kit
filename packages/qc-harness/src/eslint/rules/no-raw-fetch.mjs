// One module builds a URL and calls fetch. docs/architecture.md.

import { filenameOf, optionsOf, pathSuffix, schemaOf } from "../options.mjs";

const DEFAULT_CLIENT = "platform/api-client.ts";
// The names of the global object, so `window.fetch` and `globalThis["fetch"]` are the same fetch.
const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self", "global"]);

/** The property a member or a destructured key names, when the code spells it literally. */
function keyName(node, computed) {
  if (!computed && node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

const isGlobalObject = (node) => node?.type === "Identifier" && GLOBAL_OBJECTS.has(node.name);

export default {
  meta: {
    type: "problem",
    docs: { description: "fetch belongs to the api client" },
    schema: schemaOf({ client: { type: "string" } }),
    messages: { raw: "Call the api client. Only {{client}} may call fetch or build a URL." },
  },
  create(context) {
    const client = optionsOf(context).client ?? DEFAULT_CLIENT;
    if (pathSuffix(client).test(filenameOf(context))) return {};
    const report = (node) => context.report({ node, messageId: "raw", data: { client } });
    return {
      // Every use of the global fetch, not only a call: `const f = fetch` hands the same function on.
      // A local binding named fetch is not the global, and a `typeof fetch` type reads no value.
      "Program:exit"() {
        for (const reference of context.sourceCode.scopeManager.globalScope.through) {
          const { identifier } = reference;
          if (identifier.name !== "fetch" || identifier.parent?.type === "TSTypeQuery") continue;
          report(identifier);
        }
      },
      MemberExpression(node) {
        if (isGlobalObject(node.object) && keyName(node.property, node.computed) === "fetch") report(node);
      },
      VariableDeclarator(node) {
        if (node.id.type !== "ObjectPattern" || !isGlobalObject(node.init)) return;
        for (const property of node.id.properties) {
          if (property.type === "Property" && keyName(property.key, property.computed) === "fetch") report(property);
        }
      },
      NewExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "URL") report(node);
      },
    };
  },
};
