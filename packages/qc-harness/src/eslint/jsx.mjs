// What the JSX rules share: reading an element, and resolving an attribute to the function it runs.

export const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);

export function tagName(name) {
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXMemberExpression") return `${tagName(name.object)}.${name.property.name}`;
  return null;
}

/** undefined when absent, the literal when static, null when computed at runtime. */
export function attributeValue(element, name) {
  const attr = element.attributes.find((a) => a.type === "JSXAttribute" && a.name.name === name);
  if (!attr) return undefined;
  if (attr.value === null) return true;
  if (attr.value.type === "Literal") return attr.value.value;
  const expression = attr.value.expression;
  return expression?.type === "Literal" ? expression.value : null;
}

/** `useCallback(fn, deps)` and any wrapper like it: the handler is the first function argument. */
export function unwrap(node) {
  if (node?.type === "CallExpression") return node.arguments.find((arg) => FUNCTIONS.has(arg.type)) ?? null;
  return node && FUNCTIONS.has(node.type) ? node : null;
}

export function resolve(sourceCode, expression) {
  if (expression.type !== "Identifier") return unwrap(expression);
  for (let scope = sourceCode.getScope(expression); scope; scope = scope.upper) {
    const variable = scope.set.get(expression.name);
    if (!variable) continue;
    // Branch on the definition kind: for a parameter, `def.node` is the enclosing function, not the handler.
    const def = variable.defs[0];
    if (def?.type === "FunctionName") return def.node;
    return def?.type === "Variable" ? unwrap(def.node.init) : null;
  }
  return null;
}

export function propertyName(node) {
  return node.type === "MemberExpression" && !node.computed ? node.property.name : null;
}

/** Visit a node and everything under it, except the bodies of nested functions. */
export function walk(node, keys, visit) {
  visit(node);
  for (const key of keys[node.type] ?? []) {
    const child = node[key];
    for (const item of Array.isArray(child) ? child : [child]) {
      if (item && typeof item.type === "string" && !FUNCTIONS.has(item.type)) walk(item, keys, visit);
    }
  }
}
