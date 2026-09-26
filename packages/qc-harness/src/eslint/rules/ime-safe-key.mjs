// Enter and Escape in text entry wait for the IME, or a half-typed conversion is submitted. docs/ui.md.

import { optionsOf, schemaOf } from "../options.mjs";

const HANDLERS = new Set(["onKeyDown", "onKeyUp"]);
const ACTION_KEYS = new Set(["Enter", "Escape"]);
const EQUALITY = new Set(["===", "==", "!==", "!="]);
const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);
// An input of these types takes no typed text, so no IME composes into it.
const NON_TEXT_TYPES = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);
const IME_KEY_CODE = 229;

function tagName(name) {
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXMemberExpression") return `${tagName(name.object)}.${name.property.name}`;
  return null;
}

/** undefined when absent, the literal when static, null when computed at runtime. */
function attributeValue(element, name) {
  const attr = element.attributes.find((a) => a.type === "JSXAttribute" && a.name.name === name);
  if (!attr) return undefined;
  if (attr.value === null) return true;
  if (attr.value.type === "Literal") return attr.value.value;
  const expression = attr.value.expression;
  return expression?.type === "Literal" ? expression.value : null;
}

function isTextEntry(element, components) {
  const editable = attributeValue(element, "contentEditable");
  if (editable !== undefined && editable !== false && editable !== "false") return true;
  const name = tagName(element.name);
  if (name === "textarea" || components.has(name)) return true;
  if (name !== "input") return false;
  const type = attributeValue(element, "type");
  return typeof type !== "string" || !NON_TEXT_TYPES.has(type);
}

/** `useCallback(fn, deps)` and any wrapper like it: the handler is the first function argument. */
function unwrap(node) {
  if (node?.type === "CallExpression") return node.arguments.find((arg) => FUNCTIONS.has(arg.type)) ?? null;
  return node && FUNCTIONS.has(node.type) ? node : null;
}

function resolve(sourceCode, expression) {
  if (expression.type !== "Identifier") return unwrap(expression);
  for (let scope = sourceCode.getScope(expression); scope; scope = scope.upper) {
    const variable = scope.set.get(expression.name);
    if (!variable) continue;
    const node = variable.defs[0]?.node;
    if (node?.type === "FunctionDeclaration") return node;
    return node?.type === "VariableDeclarator" ? unwrap(node.init) : null;
  }
  return null;
}

function propertyName(node) {
  return node.type === "MemberExpression" && !node.computed ? node.property.name : null;
}

function isKey(node) {
  return propertyName(node) === "key" || (node.type === "Identifier" && node.name === "key");
}

function isActionKey(node) {
  return node.type === "Literal" && ACTION_KEYS.has(node.value);
}

function isKeyCheck(node) {
  if (node.type !== "BinaryExpression" || !EQUALITY.has(node.operator)) return false;
  return (isKey(node.left) && isActionKey(node.right)) || (isKey(node.right) && isActionKey(node.left));
}

function isInlineGuard(node) {
  if (propertyName(node) === "isComposing") return true;
  if (node.type !== "BinaryExpression" || !EQUALITY.has(node.operator)) return false;
  const sides = [node.left, node.right];
  return sides.some((side) => propertyName(side) === "keyCode") && sides.some((side) => side.type === "Literal" && side.value === IME_KEY_CODE);
}

function walk(node, keys, visit) {
  visit(node);
  for (const key of keys[node.type] ?? []) {
    const child = node[key];
    for (const item of Array.isArray(child) ? child : [child]) {
      if (item && typeof item.type === "string" && !FUNCTIONS.has(item.type)) walk(item, keys, visit);
    }
  }
}

function contains(outer, inner) {
  return outer.range[0] <= inner.range[0] && inner.range[1] <= outer.range[1];
}

function exitsEarly(statement) {
  if (statement.type === "ReturnStatement") return true;
  return statement.type === "BlockStatement" && statement.body.at(-1)?.type === "ReturnStatement";
}

/** What one handler does with Enter and Escape, and what guards it. */
function survey(handler, keys, isGuard) {
  const found = { checks: [], inline: [], guards: [] };
  walk(handler.body, keys, (node) => {
    if (isKeyCheck(node)) found.checks.push(node);
    if (node.type === "SwitchStatement" && isKey(node.discriminant)) {
      for (const branch of node.cases) if (branch.test && isActionKey(branch.test)) found.checks.push(branch.test);
    }
    if (isInlineGuard(node)) found.inline.push(node);
    if (node.type === "IfStatement" && exitsEarly(node.consequent)) {
      let guarded = false;
      walk(node.test, keys, (inner) => (guarded ||= isGuard(inner)));
      if (guarded) found.guards.push(node);
    }
  });
  return found;
}

/** The first statement the branch runs when the check holds. */
function branchHead(check) {
  let node = check;
  while (node.parent && !FUNCTIONS.has(node.parent.type)) {
    const parent = node.parent;
    if (parent.type === "SwitchCase" && parent.test === node) return parent.consequent[0];
    if (parent.type === "IfStatement" && parent.test === node) {
      return parent.consequent.type === "BlockStatement" ? parent.consequent.body[0] : parent.consequent;
    }
    node = parent;
  }
  return undefined;
}

function isGuarded(check, guards) {
  const head = branchHead(check);
  return guards.some((guard) => guard === head || (guard.range[1] <= check.range[0] && contains(guard.parent, check)));
}

export default {
  meta: {
    type: "problem",
    docs: { description: "Enter and Escape in text entry act only after an early return on the IME guard" },
    schema: schemaOf({
      components: { type: "array", items: { type: "string" } },
      guards: { type: "array", items: { type: "string" } },
    }),
    messages: {
      unguarded: "Enter and Escape in text entry must wait for the IME: return early on {{guard}} before this branch.",
      inline: "An inline IME check is a second mechanism, and isComposing alone misses keyCode 229: call {{guard}}.",
    },
  },
  create(context) {
    const options = optionsOf(context);
    const components = new Set(options.components ?? []);
    const guards = new Set(options.guards ?? []);
    const guard = guards.size > 0 ? [...guards].join(" or ") : "isComposing or keyCode 229";
    const isGuard =
      guards.size > 0
        ? (node) => node.type === "CallExpression" && guards.has(node.callee.name ?? propertyName(node.callee))
        : isInlineGuard;
    const sourceCode = context.sourceCode;
    const reported = new Set();
    function report(node, messageId) {
      if (reported.has(node)) return;
      reported.add(node);
      context.report({ node, messageId, data: { guard } });
    }
    return {
      JSXAttribute(node) {
        if (!HANDLERS.has(node.name.name) || node.value?.type !== "JSXExpressionContainer") return;
        if (!isTextEntry(node.parent, components)) return;
        const handler = resolve(sourceCode, node.value.expression);
        if (!handler) return;
        const found = survey(handler, sourceCode.visitorKeys, isGuard);
        for (const check of found.checks) if (!isGuarded(check, found.guards)) report(check, "unguarded");
        if (guards.size > 0) for (const check of found.inline) report(check, "inline");
      },
    };
  },
};
