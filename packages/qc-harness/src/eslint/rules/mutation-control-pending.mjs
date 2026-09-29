// A control that starts a mutation shows it is pending, or a second click sends the write twice. docs/ui.md.

import { attributeValue, lookup, propertyName, resolve, tagName, walk } from "../jsx.mjs";
import { optionsOf, schemaOf } from "../options.mjs";

const MUTATIONS = new Set(["mutate", "mutateAsync"]);
// `mutate` returns nothing, so returning it hands the caller no promise to track.
const PROMISE = "mutateAsync";
const DEFAULT_HANDLERS = ["onClick", "onSelect", "onConfirm"];

/** A literal `false` binds nothing, so neither does the string "false". */
function passes(element, name) {
  const value = attributeValue(element, name);
  return value !== undefined && value !== false && value !== "false";
}

function isUseMutation(init) {
  if (init?.type !== "CallExpression") return false;
  return (init.callee.type === "Identifier" ? init.callee.name : propertyName(init.callee)) === "useMutation";
}

function keyName(property) {
  if (property.computed) return null;
  return property.key.type === "Identifier" ? property.key.name : property.key.value;
}

/** The pattern property that declares `identifier`: `{ mutate }`, `{ mutate: go }`, `{ mutate = noop }`. */
function declaringProperty(pattern, identifier) {
  return pattern.properties.find((property) => {
    if (property.type !== "Property") return false;
    const target = property.value.type === "AssignmentPattern" ? property.value.left : property.value;
    return target.range[0] === identifier.range[0];
  });
}

/**
 * What an identifier holds when it comes from `useMutation(...)`: the mutation object itself,
 * or one of its two functions under whatever local name it was given.
 * @returns {{ object: true } | { method: string } | null}
 */
function fromUseMutation(sourceCode, identifier) {
  const def = lookup(sourceCode, identifier)?.defs[0];
  if (def?.type !== "Variable" || !isUseMutation(def.node.init)) return null;
  if (def.node.id.type === "Identifier") return { object: true };
  if (def.node.id.type !== "ObjectPattern") return null;
  const method = keyName(declaringProperty(def.node.id, def.name) ?? { computed: true });
  return MUTATIONS.has(method) ? { method } : null;
}

/** `m.mutate` on any object, or a name `useMutation` handed out. */
function mutationCalled(sourceCode, callee) {
  if (callee.type === "Identifier") return fromUseMutation(sourceCode, callee)?.method ?? null;
  const name = propertyName(callee);
  return MUTATIONS.has(name) ? name : null;
}

/** A handler that is the mutation function itself, as in `onClick={m.mutate}`. */
function mutationReferenced(sourceCode, expression) {
  if (expression.type === "Identifier") return fromUseMutation(sourceCode, expression)?.method ?? null;
  if (propertyName(expression) === null || expression.object.type !== "Identifier") return null;
  const held = fromUseMutation(sourceCode, expression.object);
  return held?.object && MUTATIONS.has(propertyName(expression)) ? propertyName(expression) : null;
}

/** The call, or a chain rooted at it such as `.then(close)`, is the handler's result. */
function isReturned(call) {
  let node = call;
  for (;;) {
    const parent = node.parent;
    const chained = parent.type === "MemberExpression" && parent.object === node && parent.parent.callee === parent;
    if (parent.type !== "ChainExpression" && !chained) break;
    node = chained ? parent.parent : parent;
  }
  const parent = node.parent;
  return parent.type === "ReturnStatement" || (parent.type === "ArrowFunctionExpression" && parent.body === node);
}

/** Whether the handler starts a mutation it does not hand back to its caller. */
function startsUnreturnedMutation(sourceCode, handler) {
  let found = false;
  walk(handler.body, sourceCode.visitorKeys, (node) => {
    if (node.type !== "CallExpression") return;
    const name = mutationCalled(sourceCode, node.callee);
    if (name && !(name === PROMISE && isReturned(node))) found = true;
  });
  return found;
}

function startsMutation(sourceCode, expression) {
  const referenced = mutationReferenced(sourceCode, expression);
  if (referenced) return referenced !== PROMISE;
  const handler = resolve(sourceCode, expression);
  return Boolean(handler) && startsUnreturnedMutation(sourceCode, handler);
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
          if (!startsMutation(sourceCode, attr.value.expression)) continue;
          context.report({ node: attr, messageId: "pending", data: { button, prop } });
          return;
        }
      },
    };
  },
};
