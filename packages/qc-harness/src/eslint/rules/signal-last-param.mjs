// Cancellation is a parameter, not something a developer remembers. docs/architecture.md.

import { optionsOf, schemaOf } from "../options.mjs";

const DEFAULT_NAME = "signal";

function isSignal(param, pattern) {
  const node = param.type === "AssignmentPattern" ? param.left : param;
  if (node.type !== "Identifier") return false;
  return pattern.test(node.name);
}

export default {
  meta: {
    type: "problem",
    docs: { description: "an exported async function takes a cancellation token last" },
    schema: schemaOf({ name: { type: "string" }, type: { type: "string" } }),
    messages: { missing: "'{{name}}' can outlive the interaction: take an {{type}} as the last parameter." },
  },
  create(context) {
    const options = optionsOf(context);
    const pattern = new RegExp(`${options.name ?? DEFAULT_NAME}$`, "i");
    const type = options.type ?? "AbortSignal";
    function check(node, name) {
      if (!node.async) return;
      const params = node.params;
      if (params.length > 0 && isSignal(params[params.length - 1], pattern)) return;
      context.report({ node, messageId: "missing", data: { name, type } });
    }
    return {
      "ExportNamedDeclaration > FunctionDeclaration"(node) {
        check(node, node.id ? node.id.name : "function");
      },
      "ExportNamedDeclaration > VariableDeclaration > VariableDeclarator"(node) {
        const init = node.init;
        if (!init) return;
        if (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") {
          check(init, node.id.type === "Identifier" ? node.id.name : "function");
        }
      },
    };
  },
};
