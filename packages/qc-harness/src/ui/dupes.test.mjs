import { strict as assert } from "node:assert";
import { test } from "node:test";
import { catalogEntries } from "./catalog.mjs";
import { findDupes, findingId } from "./dupes.mjs";
import { loadTypeScript } from "./typescript.mjs";

const ts = loadTypeScript();
const options = { componentRoots: ["ui"], layers: {} };
const settings = { callees: ["cn", "clsx", "cva", "twMerge"], minClassLength: 20, minFiles: 3 };
const find = (files, over = {}) =>
  findDupes(ts, files, { ...settings, ...over, entries: catalogEntries(ts, options, files) });
const kinds = (found, kind) => found.filter((one) => one.kind === kind);

const LONG = "flex items-center gap-2 rounded-md border px-3 py-2";

test("a long class string in three files is reported once, whatever the token order", () => {
  const reordered = "px-3 py-2 gap-2 flex items-center rounded-md border";
  const files = [
    { path: "ui/a.tsx", contents: `export const A = () => <div className="${LONG}" />;` },
    { path: "ui/b.tsx", contents: `export const B = () => <div className={cn("${reordered}")} />;` },
    { path: "ui/c.tsx", contents: `export const C = () => <div className="${LONG}" />;` },
  ];
  const [one, ...rest] = kinds(find(files), "class-string");
  assert.equal(rest.length, 0);
  assert.deepEqual(one.files, ["ui/a.tsx", "ui/b.tsx", "ui/c.tsx"]);
  assert.equal(one.key, [...LONG.split(" ")].sort().join(" "));
});

test("a class string below the length, or in fewer files than the minimum, or twice in one file, is not reported", () => {
  const files = [
    { path: "ui/a.tsx", contents: `export const A = () => <div className="${LONG}" />;` },
    { path: "ui/b.tsx", contents: `export const B = () => <><i className="${LONG}" /><i className="${LONG}" /></>;` },
    { path: "ui/c.tsx", contents: `export const C = () => <div className="flex p-2" />;` },
    { path: "ui/d.tsx", contents: `export const D = () => <div className="flex p-2" />;` },
    { path: "ui/e.tsx", contents: `export const E = () => <div className="flex p-2" />;` },
  ];
  assert.deepEqual(kinds(find(files), "class-string"), []);
});

test("two exported components with one name in different files are reported", () => {
  const files = [
    { path: "ui/a/card.tsx", contents: "export const Card = () => null;" },
    { path: "ui/b/card.tsx", contents: "export function Card() { return null; }" },
    { path: "ui/c.tsx", contents: "export const Other = () => null;" },
  ];
  const [one] = kinds(find(files), "component-name");
  assert.deepEqual([one.key, one.files], ["Card", ["ui/a/card.tsx", "ui/b/card.tsx"]]);
});

const tree = (classes) =>
  `export const T = () => (<section className="${classes[0]}"><header className="${classes[1]}"><h2 className="${classes[2]}">t</h2></header><p className="${classes[3]}">x</p></section>);`;

test("a tree of four elements with one skeleton and a class overlap of 0.8 or more is reported across files", () => {
  const same = ["card p-4", "flex gap-2", "font-bold text-lg", "text-sm text-muted"];
  const near = ["card p-4", "flex gap-2", "font-bold text-lg", "text-sm text-muted extra"];
  const files = [
    { path: "ui/a.tsx", contents: tree(same) },
    { path: "ui/b.tsx", contents: tree(near) },
  ];
  const [one, ...rest] = kinds(find(files), "jsx-tree");
  assert.equal(rest.length, 0);
  assert.deepEqual(one.files, ["ui/a.tsx", "ui/b.tsx"]);
  assert.equal(one.elements, 4);
});

test("a tree below the overlap, with another skeleton, or in one file is not reported", () => {
  const same = ["card p-4", "flex gap-2", "font-bold text-lg", "text-sm text-muted"];
  const apart = ["a-1", "b-1", "c-1", "d-1"];
  const other = tree(same).replace("<p ", "<div ").replace("</p>", "</div>");
  assert.deepEqual(kinds(find([{ path: "ui/a.tsx", contents: tree(same) }, { path: "ui/b.tsx", contents: tree(apart) }]), "jsx-tree"), []);
  assert.deepEqual(kinds(find([{ path: "ui/a.tsx", contents: tree(same) }, { path: "ui/b.tsx", contents: other }]), "jsx-tree"), []);
  assert.deepEqual(kinds(find([{ path: "ui/a.tsx", contents: tree(same) + "\n" + tree(same).replace("T =", "U =") }]), "jsx-tree"), []);
});

test("an outer tree reports once, not again for each subtree it holds", () => {
  const big = (extra) =>
    `export const T = () => (<main className="m"><section className="a b"><header className="c d"><h2 className="e f">t</h2></header><p className="g h">x</p></section><footer className="${extra}">z</footer></main>);`;
  const found = kinds(find([{ path: "ui/a.tsx", contents: big("x y") }, { path: "ui/b.tsx", contents: big("x y") }]), "jsx-tree");
  assert.equal(found.length, 1);
  assert.equal(found[0].elements, 6);
});

test("findingId names the kind and the key, so a baseline can hold it", () => {
  assert.equal(findingId({ kind: "component-name", key: "Card" }), "component-name:Card");
});
