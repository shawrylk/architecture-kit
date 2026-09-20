// One module builds a URL and calls fetch. docs/architecture.md.

import { filenameOf, optionsOf, pathSuffix, schemaOf } from "../options.mjs";

const DEFAULT_CLIENT = "platform/api-client.ts";

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
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "fetch") report(node);
      },
      NewExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "URL") report(node);
      },
    };
  },
};
