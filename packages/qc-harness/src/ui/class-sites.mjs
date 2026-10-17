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
 * @returns {{start: number, end: number, leftOpen: boolean, rightOpen: boolean}[]} in source order, none twice
 */
export function classSpans(ts, file, callees) {
  const callable = new Set(callees);
  const found = new Map();

  function collect(node, skipKeys) {
    if (ts.isTypeNode(node)) return;
    let keys = skipKeys;
    if (ts.isCallExpression(node)) {
      const name = calleeName(ts, node.expression);
      if (name !== null && callable.has(name)) keys = name === "cva";
    }
    const isKey = node.parent && ts.isPropertyAssignment(node.parent) && node.parent.name === node;
    if (!(isKey && keys)) {
      for (const span of spansOf(ts, file, node)) found.set(span.start, span);
      if (ts.isTemplateExpression(node)) {
        for (const span of node.templateSpans) collect(span.expression, keys);
        return;
      }
    }
    ts.forEachChild(node, (child) => collect(child, keys));
  }

  function visit(node) {
    if (ts.isJsxAttribute(node) && CLASS_ATTRIBUTES.has(node.name.getText(file)) && node.initializer) {
      collect(node.initializer, false);
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(ts, node.expression);
      if (name !== null && callable.has(name)) {
        for (const argument of node.arguments) collect(argument, name === "cva");
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
    out.push({ text: found[0], start: span.start + found.index, end: span.start + found.index + found[0].length });
  }
  return out;
}

/** Every class token of a file, with its range, in source order. */
export function classTokensOf(ts, file, callees) {
  return classSpans(ts, file, callees).flatMap((span) => tokensOfSpan(file.text, span));
}
