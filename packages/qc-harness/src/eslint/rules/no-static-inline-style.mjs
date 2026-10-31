import { tagName } from "../jsx.mjs";
import { schemaOf } from "../options.mjs";

/** Branch: unwraps type assertions before classifying the style expression. */
function expressionOf(node) {
  while (["TSAsExpression", "TSTypeAssertion", "TSSatisfiesExpression", "TSNonNullExpression"].includes(node?.type)) {
    node = node.expression;
  }
  return node;
}

/** Branch: recognizes literal values without evaluating runtime expressions. */
function isLiteral(node) {
  node = expressionOf(node);
  if (node.type === "Literal") return true;
  if (node.type === "TemplateLiteral") return node.expressions.length === 0;
  return node.type === "UnaryExpression" && ["-", "+"].includes(node.operator) &&
    node.argument.type === "Literal" && typeof node.argument.value === "number";
}

export default {
  meta: {
    type: "problem",
    docs: { description: "Use classes for static presentation and inline styles for runtime values" },
    schema: schemaOf({}),
    messages: { static: "Move static inline styles to a class or theme token; reserve style for runtime values." },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (tagName(node.name) !== "style" || node.value?.type !== "JSXExpressionContainer") return;
        const object = expressionOf(node.value.expression);
        if (object?.type !== "ObjectExpression" || object.properties.length === 0) return;
        const literal = object.properties.every((property) =>
          property.type === "Property" && property.kind === "init" && !property.method &&
          (!property.computed || isLiteral(property.key)) && isLiteral(property.value));
        if (literal) context.report({ node, messageId: "static" });
      },
    };
  },
};
