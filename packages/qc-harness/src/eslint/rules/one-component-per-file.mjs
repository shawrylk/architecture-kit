// Branch: each TSX file owns one component declaration.

import { FUNCTIONS, propertyName, walk } from "../jsx.mjs";
import { filenameOf, schemaOf } from "../options.mjs";

function returnsJsxBranch(node) {
  if (!node) return false;
  if (node.type === "JSXElement" || node.type === "JSXFragment") return true;
  if (node.type === "ConditionalExpression") return returnsJsxBranch(node.consequent) || returnsJsxBranch(node.alternate);
  if (node.type === "LogicalExpression") return returnsJsxBranch(node.left) || returnsJsxBranch(node.right);
  if (node.type === "SequenceExpression") return returnsJsxBranch(node.expressions.at(-1));
  if (["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion"].includes(node.type)) {
    return returnsJsxBranch(node.expression);
  }
  return false;
}

function componentBranch(node, keys) {
  if (!node) return false;
  if (node.type === "CallExpression") return ["forwardRef", "memo"].includes(node.callee.name ?? propertyName(node.callee));
  if (["TSAsExpression", "TSSatisfiesExpression"].includes(node.type)) return componentBranch(node.expression, keys);
  if (!FUNCTIONS.has(node.type)) return false;
  if (node.body.type !== "BlockStatement") return returnsJsxBranch(node.body);
  let found = false;
  walk(node.body, keys, (child) => {
    if (child.type === "ReturnStatement" && returnsJsxBranch(child.argument)) found = true;
  });
  return found;
}

export default {
  meta: {
    type: "suggestion",
    docs: { description: "Declare at most one React component per TSX file." },
    schema: schemaOf({}),
    messages: { multiple: "Components {{first}} and {{second}} share a file. Move each component into its own file." },
  },
  create(context) {
    if (!filenameOf(context).endsWith(".tsx")) return {};
    const components = [];
    const keys = context.sourceCode.visitorKeys;
    function collectBranch(node, name, value) {
      if (/^[A-Z]/.test(name ?? "") && componentBranch(value, keys)) components.push({ node, name });
    }
    return {
      FunctionDeclaration(node) {
        collectBranch(node, node.id?.name, node);
      },
      VariableDeclarator(node) {
        if (node.id.type === "Identifier") collectBranch(node, node.id.name, node.init);
      },
      "Program:exit"() {
        components.sort((left, right) => left.node.range[0] - right.node.range[0]);
        for (const component of components.slice(1)) {
          context.report({ node: component.node, messageId: "multiple", data: { first: components[0].name, second: component.name } });
        }
      },
    };
  },
};
