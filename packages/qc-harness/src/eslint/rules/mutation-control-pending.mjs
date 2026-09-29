// A control that starts a mutation shows it is pending, or a second click sends the write twice. docs/ui.md.

import { attributeValue, propertyName, resolve, tagName, walk } from "../jsx.mjs";
import { optionsOf, schemaOf } from "../options.mjs";

const MUTATIONS = new Set(["mutate", "mutateAsync"]);
// `mutate` returns nothing, so returning it hands the caller no promise to track.
const PROMISE = "mutateAsync";
const DEFAULT_HANDLERS = ["onClick", "onSelect", "onConfirm"];

/** A literal `false` binds nothing, so it does not count as passing the prop. */
function passes(element, name) {
  const value = attributeValue(element, name);
  return value !== undefined && value !== false;
}

/** The call is the handler's result: an expression-body arrow, or a direct `return`. */
function isReturned(call) {
  if (propertyName(call.callee) !== PROMISE) return false;
  const node = call.parent.type === "ChainExpression" ? call.parent : call;
  const parent = node.parent;
  return parent.type === "ReturnStatement" || (parent.type === "ArrowFunctionExpression" && parent.body === node);
}

/** Whether the handler starts a mutation it does not hand back to its caller. */
function startsUnreturnedMutation(handler, keys) {
  let found = false;
  walk(handler.body, keys, (node) => {
    if (node.type === "CallExpression" && MUTATIONS.has(propertyName(node.callee)) && !isReturned(node)) found = true;
  });
  return found;
}

export default {
  meta: {
    type: "problem",
    docs: { description: "A handler that calls mutate or mutateAsync sits on a control that shows the pending state" },
    schema: schemaOf({
      button: { type: "string" },
      prop: { type: "string" },
      handlers: { type: "array", items: { type: "string" } },
    }),
    messages: {
      pending:
        "This handler starts a mutation with no pending state: pass {{prop}} on <{{button}}>, or disabled with aria-busy, or return the promise.",
    },
  },
  create(context) {
    const options = optionsOf(context);
    const button = options.button ?? "Button";
    const prop = options.prop ?? "loading";
    const handlers = new Set(options.handlers ?? DEFAULT_HANDLERS);
    const sourceCode = context.sourceCode;
    return {
      JSXOpeningElement(node) {
        if ((tagName(node.name) === button && passes(node, prop)) || (passes(node, "disabled") && passes(node, "aria-busy"))) return;
        for (const attr of node.attributes) {
          if (attr.type !== "JSXAttribute" || !handlers.has(attr.name.name) || attr.value?.type !== "JSXExpressionContainer") continue;
          const handler = resolve(sourceCode, attr.value.expression);
          if (!handler || !startsUnreturnedMutation(handler, sourceCode.visitorKeys)) continue;
          context.report({ node: attr, messageId: "pending", data: { button, prop } });
          return;
        }
      },
    };
  },
};
