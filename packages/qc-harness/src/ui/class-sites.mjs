// Where a class token can sit in a source file, and nowhere else: string literals in a `className` or
// `class` attribute, in a call to a class callee, and in a `cva` variant object, plus the static parts of
// a template literal in those places. The codemod and the duplicate finder read the same sites, so they
// agree on what a class string is.

const CLASS_ATTRIBUTES = new Set(["className", "class"]);

function calleeName(ts, expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

/** The text spans of a string-like node, as source ranges inside its quotes or between its substitutions. */
function spansOf(ts, file, node) {
  const start = node.getStart(file);
  if (ts.isIdentifier(node)) {
    return [{ start, end: node.getEnd(), leftOpen: false, rightOpen: false, identifierKey: true }];
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [{ start: start + 1, end: node.getEnd() - 1, leftOpen: false, rightOpen: false }];
  }
  if (ts.isTemplateExpression(node)) {
    const spans = [{ node: node.head, leftOpen: false, rightOpen: true, close: 2 }];
    node.templateSpans.forEach((span, index) => {
      const last = index === node.templateSpans.length - 1;
      spans.push({ node: span.literal, leftOpen: true, rightOpen: !last, close: last ? 1 : 2 });
    });
    return spans.map(({ node: part, leftOpen, rightOpen, close }) => ({
      start: part.getStart(file) + 1,
      end: part.getEnd() - close,
      leftOpen,
      rightOpen,
    }));
  }
  return [];
}

/**
 * Every span of class text in a file.
 * @returns {{start: number, end: number, leftOpen: boolean, rightOpen: boolean, identifierKey?: boolean}[]} in source order, none twice
 */
export function classSpans(ts, file, callees) {
  const callable = new Set(callees);
  const found = new Map();
  let checker;

  function take(node) {
    for (const span of spansOf(ts, file, node)) found.set(span.start, span);
  }

  function propertyName(property) {
    if (!ts.isPropertyAssignment(property)) return null;
    const { name } = property;
    return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
  }

  function propertyValue(object, wanted) {
    if (!ts.isObjectLiteralExpression(object)) return [];
    return object.properties.filter((p) => wanted.has(propertyName(p))).map((p) => p.initializer);
  }

  /** Fragment: resolves a variant object through a same-file const binding. */
  function variantObject(node) {
    if (ts.isObjectLiteralExpression(node)) return node;
    if (!ts.isIdentifier(node) && !ts.isShorthandPropertyAssignment(node)) return null;
    if (!checker) {
      const options = { noLib: true, noResolve: true };
      const host = ts.createCompilerHost(options);
      host.getSourceFile = (name) => name === file.fileName ? file : undefined;
      checker = ts.createProgram([file.fileName], options, host).getTypeChecker();
    }
    const symbol = ts.isShorthandPropertyAssignment(node)
      ? checker.getShorthandAssignmentValueSymbol(node)
      : checker.getSymbolAtLocation(node);
    const declaration = symbol?.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.getSourceFile() !== file) return null;
    if (!ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)) return null;
    return declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer) ? declaration.initializer : null;
  }

  /**
   * A node whose value is class text: a string, or an expression that yields one. A condition, a comparison
   * operand and the argument of a call outside `classCallees` are not class text, so the walk stops there.
   * `objectKeys` reads the keys of an object, as `clsx({ "p-2": on })` does.
   */
  function collectValue(node, objectKeys) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      take(node);
    } else if (ts.isTemplateExpression(node)) {
      take(node);
      for (const span of node.templateSpans) collectValue(span.expression, objectKeys);
    } else if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isJsxExpression(node)
    ) {
      if (node.expression) collectValue(node.expression, objectKeys);
    } else if (ts.isConditionalExpression(node)) {
      collectValue(node.whenTrue, objectKeys);
      collectValue(node.whenFalse, objectKeys);
    } else if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      const logical =
        kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        kind === ts.SyntaxKind.BarBarToken ||
        kind === ts.SyntaxKind.QuestionQuestionToken;
      if (logical) collectValue(node.right, objectKeys);
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) collectValue(element, objectKeys);
    } else if (ts.isObjectLiteralExpression(node) && objectKeys) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property) && (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name))) take(property.name);
      }
    }
  }

  /** The class text of a `cva` call: the base, the variant values, and the class of each compound variant. */
  function collectVariants(call) {
    const [base, config] = call.arguments;
    if (base) collectValue(base, false);
    if (!config || !ts.isObjectLiteralExpression(config)) return;
    for (const property of config.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
      if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) continue;
      if (property.name.text !== "variants") continue;
      const variants = variantObject(ts.isShorthandPropertyAssignment(property) ? property : property.initializer);
      if (!variants) continue;
      for (const group of variants.properties) {
        if (!ts.isPropertyAssignment(group) || !ts.isObjectLiteralExpression(group.initializer)) continue;
        for (const option of group.initializer.properties) {
          if (ts.isPropertyAssignment(option)) collectValue(option.initializer, false);
        }
      }
    }
    for (const compound of propertyValue(config, new Set(["compoundVariants"]))) {
      if (!ts.isArrayLiteralExpression(compound)) continue;
      for (const entry of compound.elements) {
        for (const value of propertyValue(entry, CLASS_ATTRIBUTES)) collectValue(value, false);
      }
    }
  }

  function visit(node) {
    if (ts.isJsxAttribute(node) && CLASS_ATTRIBUTES.has(node.name.getText(file)) && node.initializer) {
      collectValue(node.initializer, false);
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(ts, node.expression);
      if (name === "cva" && callable.has(name)) collectVariants(node);
      else if (name !== null && callable.has(name)) {
        for (const argument of node.arguments) collectValue(argument, true);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return [...found.values()].sort((a, b) => a.start - b.start);
}

/** The whitespace-separated tokens of one span, each with its source range. A token cut by a substitution is left out. */
export function tokensOfSpan(text, span) {
  const raw = text.slice(span.start, span.end);
  const out = [];
  for (const found of raw.matchAll(/\S+/g)) {
    const touchesLeft = span.leftOpen && found.index === 0;
    const touchesRight = span.rightOpen && found.index + found[0].length === raw.length;
    if (touchesLeft || touchesRight || found[0].includes("\\")) continue;
    out.push({
      text: found[0],
      start: span.start + found.index,
      end: span.start + found.index + found[0].length,
      ...(span.identifierKey ? { identifierKey: true } : {}),
    });
  }
  return out;
}

/** Every class token of a file, with its range, in source order. */
export function classTokensOf(ts, file, callees) {
  return classSpans(ts, file, callees).flatMap((span) => tokensOfSpan(file.text, span));
}
