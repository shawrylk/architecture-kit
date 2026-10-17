// Duplicate UI the catalog cannot prevent: the same class string repeated, two components with one name,
// and two JSX trees that differ by a class or two. Each finding has an id, so a baseline can hold the
// ones that predate the gate.

import { createHash } from "node:crypto";
import { classSpans, tokensOfSpan } from "./class-sites.mjs";
import { parseSource } from "./typescript.mjs";

const MIN_TREE_ELEMENTS = 4;
const MIN_OVERLAP = 0.8;

export const findingId = (finding) => `${finding.kind}:${finding.key}`;

const shortHash = (text) => createHash("sha1").update(text).digest("hex").slice(0, 8);

/** The class strings of a file, each as its sorted tokens joined by one space. A string cut by a substitution is left out. */
function classStrings(ts, source, callees) {
  const strings = [];
  for (const span of classSpans(ts, source, callees)) {
    if (span.leftOpen || span.rightOpen) continue;
    const tokens = tokensOfSpan(source.text, span).map((token) => token.text);
    if (tokens.length > 0) strings.push({ normalized: [...new Set(tokens)].sort().join(" "), start: span.start });
  }
  return strings;
}

function classStringFindings(perFile, { minClassLength, minFiles }) {
  const byString = new Map();
  for (const { path, strings } of perFile) {
    for (const { normalized } of strings) {
      if (normalized.length < minClassLength) continue;
      byString.set(normalized, new Set([...(byString.get(normalized) ?? []), path]));
    }
  }
  return [...byString]
    .filter(([, paths]) => paths.size >= minFiles)
    .map(([key, paths]) => ({ kind: "class-string", key, files: [...paths].sort() }));
}

function componentNameFindings(entries) {
  const byName = new Map();
  for (const entry of entries) byName.set(entry.name, new Set([...(byName.get(entry.name) ?? []), entry.path]));
  return [...byName]
    .filter(([, paths]) => paths.size > 1)
    .map(([key, paths]) => ({ kind: "component-name", key, files: [...paths].sort() }));
}

/** The JSX nodes directly below `node`: its children, and the first ones inside an expression child. */
function jsxChildren(ts, node) {
  const found = [];
  const isJsx = (one) => ts.isJsxElement(one) || ts.isJsxSelfClosingElement(one) || ts.isJsxFragment(one);
  const descend = (one) => (isJsx(one) ? found.push(one) : ts.forEachChild(one, descend));
  if (ts.isJsxElement(node) || ts.isJsxFragment(node)) node.children.forEach(descend);
  return found;
}

/** Every JSX tree of four elements or more in a file, with its skeleton and the class tokens it holds. */
function jsxTrees(ts, source, strings, path) {
  const trees = [];
  const tagOf = (node) => {
    if (ts.isJsxFragment(node)) return "";
    return (ts.isJsxElement(node) ? node.openingElement : node).tagName.getText(source);
  };
  function walk(node) {
    const children = jsxChildren(ts, node).map(walk);
    const counted = (ts.isJsxFragment(node) ? 0 : 1) + children.reduce((sum, child) => sum + child.count, 0);
    const skeleton = `${tagOf(node)}(${children.map((child) => child.skeleton).join(",")})`;
    const start = node.getStart(source);
    const end = node.getEnd();
    const tokens = new Set();
    for (const one of strings) if (one.start >= start && one.start < end) one.normalized.split(" ").forEach((token) => tokens.add(token));
    const here = { path, skeleton, count: counted, start, end, tokens, line: source.getLineAndCharacterOfPosition(start).line + 1 };
    if (counted >= MIN_TREE_ELEMENTS) trees.push(here);
    return here;
  }
  const visit = (node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) walk(node);
    else ts.forEachChild(node, visit);
  };
  visit(source);
  return trees;
}

function jaccard(a, b) {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

const contains = (outer, inner) => outer.start <= inner.start && inner.end <= outer.end;

function treeFindings(trees) {
  const bySkeleton = Map.groupBy(trees, (tree) => tree.skeleton);
  const pairs = [];
  for (const group of bySkeleton.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const [a, b] = group[i].path <= group[j].path ? [group[i], group[j]] : [group[j], group[i]];
        if (a.path !== b.path && jaccard(a.tokens, b.tokens) >= MIN_OVERLAP) pairs.push({ a, b });
      }
    }
  }
  // A subtree of a duplicated pair is duplicated too; only the outermost pair is a finding.
  const maximal = pairs.filter(
    (p) => !pairs.some((q) => q !== p && q.a.path === p.a.path && q.b.path === p.b.path && contains(q.a, p.a) && contains(q.b, p.b)),
  );
  const byKey = new Map();
  for (const { a, b } of maximal) {
    const key = `${a.path}~${b.path}#${shortHash(a.skeleton)}`;
    const found = byKey.get(key) ?? { kind: "jsx-tree", key, files: [a.path, b.path], elements: a.count, locations: [] };
    found.locations.push(`${a.path}:${a.line}`, `${b.path}:${b.line}`);
    byKey.set(key, found);
  }
  return [...byKey.values()];
}

/**
 * @param ts the TypeScript module
 * @param {{path: string, contents: string}[]} files the component files
 * @param {{entries: object[], callees: string[], minClassLength: number, minFiles: number}} options `entries` are the catalog's
 * @returns {{kind: string, key: string, files: string[]}[]} sorted by kind, then key
 */
export function findDupes(ts, files, { entries, callees, minClassLength, minFiles }) {
  const perFile = [];
  const trees = [];
  for (const file of files) {
    const source = parseSource(ts, file.path, file.contents);
    const strings = classStrings(ts, source, callees);
    perFile.push({ path: file.path, strings });
    trees.push(...jsxTrees(ts, source, strings, file.path));
  }
  return [
    ...classStringFindings(perFile, { minClassLength, minFiles }),
    ...componentNameFindings(entries),
    ...treeFindings(trees),
  ].sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
}

/** The baseline file's content: the id of each finding today. */
export const baselineOfFindings = (findings) => ({ findings: findings.map(findingId).sort() });
