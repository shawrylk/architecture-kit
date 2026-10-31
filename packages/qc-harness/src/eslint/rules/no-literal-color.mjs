// Branch: presentation values use color tokens.

import { defaults } from "../../config.mjs";
import { classTokens, lookup } from "../jsx.mjs";
import { optionsOf, schemaOf } from "../options.mjs";

const COLOR = /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\w-])|(?:^|[^a-z])(?:rgba?|hsla?)\(\s*[+-]?(?:\d|\.)/i;
const PRESENTATION = new Set(["color", "fill", "stroke", "stopColor", "stop-color", "floodColor", "flood-color", "lightingColor", "lighting-color", "bgColor", "bgcolor", "backgroundColor", "borderColor", "outlineColor", "textDecorationColor", "caretColor", "accentColor"]);
const STYLE_COLOR = /color$|^(?:background|border(?:Top|Right|Bottom|Left)?|outline|boxShadow|textShadow|fill|stroke|columnRule|textDecoration)$/i;

export default {
  meta: {
    type: "suggestion",
    docs: { description: "Use color tokens instead of literal colors in presentation values." },
    schema: schemaOf({ classCallees: { type: "array", items: { type: "string" } } }),
    messages: { color: "Use a color token instead of a hex, rgb(), rgba(), hsl(), or hsla() literal." },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const callees = optionsOf(context).classCallees ?? defaults.ui.classCallees;
    const reported = new Set();

    function reportBranch(node, text) {
      if (!COLOR.test(text) || reported.has(node)) return;
      reported.add(node);
      context.report({ node, messageId: "color" });
    }

    function inspectBranch(node, seen = new Set()) {
      if (!node || seen.has(node)) return;
      seen.add(node);
      if (node.type === "Literal" && typeof node.value === "string") reportBranch(node, node.value);
      else if (node.type === "TemplateLiteral") {
        for (const part of node.quasis) reportBranch(part, part.value.cooked ?? part.value.raw);
        for (const expression of node.expressions) inspectBranch(expression, seen);
      } else if (node.type === "Identifier") {
        const definition = lookup(sourceCode, node)?.defs[0];
        if (definition?.type === "Variable" && definition.parent.kind === "const") inspectBranch(definition.node.init, seen);
      } else if (node.type === "ConditionalExpression") {
        inspectBranch(node.consequent, seen);
        inspectBranch(node.alternate, seen);
      } else if (node.type === "LogicalExpression") {
        if (node.operator !== "&&") inspectBranch(node.left, seen);
        inspectBranch(node.right, seen);
      }
      else if (node.type === "ObjectExpression") {
        for (const property of node.properties) inspectBranch(property.type === "SpreadElement" ? property.argument : property.value, seen);
      } else if (node.type === "ArrayExpression") {
        for (const element of node.elements) inspectBranch(element, seen);
      } else if (["JSXExpressionContainer", "TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion"].includes(node.type)) {
        inspectBranch(node.expression, seen);
      }
    }

    function inspectStyle(node, seen = new Set()) {
      if (!node || seen.has(node)) return;
      seen.add(node);
      if (node.type === "ObjectExpression") {
        for (const property of node.properties) {
          if (property.type === "SpreadElement") inspectStyle(property.argument, seen);
          else if (!property.computed && property.kind === "init" && STYLE_COLOR.test(property.key.name ?? property.key.value)) inspectBranch(property.value);
        }
      } else if (node.type === "Identifier") {
        const definition = lookup(sourceCode, node)?.defs[0];
        if (definition?.type === "Variable" && definition.parent.kind === "const") inspectStyle(definition.node.init, seen);
      } else if (node.type === "ConditionalExpression") {
        inspectStyle(node.consequent, seen);
        inspectStyle(node.alternate, seen);
      } else if (node.type === "LogicalExpression") {
        if (node.operator !== "&&") inspectStyle(node.left, seen);
        inspectStyle(node.right, seen);
      } else if (["JSXExpressionContainer", "TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion"].includes(node.type)) {
        inspectStyle(node.expression, seen);
      }
    }

    return {
      JSXAttribute(node) {
        const name = node.name.name;
        if (name === "style") inspectStyle(node.value);
        else if (PRESENTATION.has(name)) inspectBranch(node.value);
      },
      "Program:exit"() {
        for (const token of classTokens(sourceCode, context.filename, callees)) {
          if (!COLOR.test(token.text)) continue;
          context.report({
            loc: { start: sourceCode.getLocFromIndex(token.start), end: sourceCode.getLocFromIndex(token.end) },
            messageId: "color",
          });
        }
      },
    };
  },
};
