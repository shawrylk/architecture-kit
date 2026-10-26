// The exported React components of one source file: name, line, layer, props and the first JSDoc sentence.
// A component is a capitalized function, or a capitalized `const` bound to an arrow, a function expression,
// `forwardRef` or `memo`. The syntax tree comes from the compiler API the repository already holds.

const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
const WRAPPERS = new Set(["forwardRef", "memo"]);
const FUNCTION_COMPONENT_TYPES = new Set(["FC", "FunctionComponent", "VFC", "ForwardRefExoticComponent"]);

const isComponentName = (name) => PASCAL.test(name) && /[a-z]/.test(name);

/** The first sentence of a doc comment: to the first full stop that ends a word, or the paragraph, or the end. */
export function firstSentence(comment) {
  const paragraph = String(comment ?? "").trim().split(/\n\s*\n/)[0] ?? "";
  const flat = paragraph.replace(/\s+/g, " ").trim();
  const stop = /[.!?](?=\s|$)/.exec(flat);
  return stop ? flat.slice(0, stop.index + 1) : flat;
}

/** The layer of a file: the longest `layers` prefix that holds it, else `feature:<name>`, else `platform`. */
export function layerOf(rel, options, featureDir = "features") {
  let best = null;
  for (const [layer, prefixes] of Object.entries(options.layers ?? {})) {
    for (const prefix of [prefixes].flat()) {
      const folder = `${prefix.replace(/\/+$/, "")}/`;
      if (rel.startsWith(folder) && (best === null || folder.length > best.length)) best = { layer, length: folder.length };
    }
  }
  if (best) return best.layer;
  const parts = rel.split("/");
  const at = parts.indexOf(featureDir);
  if (at !== -1 && parts.length > at + 2) return `feature:${parts[at + 1]}`;
  return "platform";
}

const modifiersOf = (ts, node) => (ts.canHaveModifiers?.(node) ? (ts.getModifiers(node) ?? []) : (node.modifiers ?? []));
const hasModifier = (ts, node, kind) => modifiersOf(ts, node).some((modifier) => modifier.kind === kind);

function calleeName(ts, expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

/** The function, or the `forwardRef` / `memo` call, a component is bound to. Null for anything else. */
function componentValue(ts, init) {
  let node = init;
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))) node = node.expression;
  if (!node) return null;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return { fn: node, call: null, reference: null };
  if (ts.isCallExpression(node) && WRAPPERS.has(calleeName(ts, node.expression))) {
    const inner = node.arguments[0];
    const nested = inner ? componentValue(ts, inner) : null;
    return { fn: nested?.fn ?? null, call: node, reference: inner && ts.isIdentifier(inner) ? inner.text : null };
  }
  return null;
}

function memberNames(ts, members) {
  const names = [];
  for (const member of members) {
    if (!(ts.isPropertySignature(member) || ts.isMethodSignature(member))) continue;
    if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) names.push(member.name.text);
  }
  return names;
}

/** The prop names of a type reference to a local interface or alias, with what an interface extends. */
function propsOfReference(ts, name, types, seen) {
  const declared = types.get(name);
  if (!declared || seen.has(name)) return [];
  seen.add(name);
  if (ts.isTypeAliasDeclaration(declared)) return propsOfType(ts, declared.type, types, seen);
  const inherited = (declared.heritageClauses ?? []).flatMap((clause) =>
    clause.types.flatMap((one) => (ts.isIdentifier(one.expression) ? propsOfReference(ts, one.expression.text, types, seen) : [])),
  );
  return [...memberNames(ts, declared.members), ...inherited];
}

/** The prop names a type declares, following local interfaces, aliases, unions and intersections. */
function propsOfType(ts, node, types, seen = new Set()) {
  if (!node) return [];
  if (ts.isParenthesizedTypeNode(node)) return propsOfType(ts, node.type, types, seen);
  if (ts.isTypeLiteralNode(node)) return memberNames(ts, node.members);
  if (ts.isIntersectionTypeNode(node) || ts.isUnionTypeNode(node)) return node.types.flatMap((one) => propsOfType(ts, one, types, seen));
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) return propsOfReference(ts, node.typeName.text, types, seen);
  return [];
}

function bindingNames(ts, pattern) {
  if (!pattern || !ts.isObjectBindingPattern(pattern)) return [];
  return pattern.elements
    .filter((element) => !element.dotDotDotToken)
    .map((element) => element.propertyName ?? element.name)
    .filter((name) => ts.isIdentifier(name) || ts.isStringLiteral(name))
    .map((name) => name.text);
}

function typeNameOf(ts, reference) {
  if (ts.isIdentifier(reference.typeName)) return reference.typeName.text;
  return reference.typeName.right.text;
}

function propsOf(ts, info, types, declared) {
  const { fn, call, annotation, reference } = info;
  const typeArguments = [];
  if (annotation && ts.isTypeReferenceNode(annotation) && FUNCTION_COMPONENT_TYPES.has(typeNameOf(ts, annotation))) {
    typeArguments.push(annotation.typeArguments?.[0]);
  }
  if (call?.typeArguments) typeArguments.push(calleeName(ts, call.expression) === "forwardRef" ? call.typeArguments[1] : call.typeArguments[0]);
  const target = fn ?? (reference ? declared.get(reference)?.fn : null);
  const first = target?.parameters?.[0];
  const typed = [...typeArguments, first?.type].flatMap((type) => propsOfType(ts, type, types));
  return [...new Set(typed.length > 0 ? typed : bindingNames(ts, first?.name))];
}

function describe(ts, statement) {
  const doc = ts.getJSDocCommentsAndTags(statement).filter((one) => ts.isJSDoc(one)).at(-1);
  return doc ? firstSentence(ts.getTextOfJSDocComment(doc.comment) ?? "") : "";
}

/** Every component a file declares, by local name, whether or not it is exported. */
function declaredComponents(ts, file) {
  const types = new Map();
  const declared = new Map();
  for (const statement of file.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      types.set(statement.name.text, statement);
    } else if (ts.isFunctionDeclaration(statement) && statement.name && isComponentName(statement.name.text)) {
      declared.set(statement.name.text, { statement, nameNode: statement.name, fn: statement, call: null, reference: null });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !isComponentName(declaration.name.text) || !declaration.initializer) continue;
        const value = componentValue(ts, declaration.initializer);
        if (value) declared.set(declaration.name.text, { statement, nameNode: declaration.name, annotation: declaration.type, ...value });
      }
    }
  }
  return { types, declared };
}

/** The exported name of each exported component, mapped to its local name. */
function exportedNames(ts, file, declared) {
  const exported = new Map();
  for (const statement of file.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isVariableStatement(statement)) && hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword)) {
      const names = ts.isFunctionDeclaration(statement)
        ? [statement.name?.text]
        : statement.declarationList.declarations.map((one) => (ts.isIdentifier(one.name) ? one.name.text : null));
      for (const name of names) if (name && declared.has(name)) exported.set(name, name);
    } else if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        const local = (element.propertyName ?? element.name).text;
        if (declared.has(local)) exported.set(element.name.text === "default" ? local : element.name.text, local);
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression) && declared.has(statement.expression.text)) {
      exported.set(statement.expression.text, statement.expression.text);
    }
  }
  return exported;
}

/**
 * @param ts the TypeScript module
 * @param {string} rel the repository-relative path
 * @param {string} text the source
 * @returns {{name: string, path: string, line: number, props: string[], description: string}[]} sorted by name
 */
export function extractComponents(ts, rel, text) {
  const file = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const { types, declared } = declaredComponents(ts, file);
  const found = [];
  for (const [name, local] of exportedNames(ts, file, declared)) {
    const info = declared.get(local);
    const line = file.getLineAndCharacterOfPosition(info.nameNode.getStart(file)).line + 1;
    found.push({ name, path: rel, line, props: propsOf(ts, info, types, declared), description: describe(ts, info.statement) });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}
