import { strict as assert } from "node:assert";
import { test } from "node:test";
import { findComponents, formatFound, tokensOf } from "./find.mjs";

const entries = [
  { name: "ConfirmDialog", path: "ui/confirm-dialog.tsx", props: ["title", "onConfirm"], description: "Asks the user to confirm a destructive action." },
  { name: "PhotoGrid", path: "features/photos/photo-grid.tsx", props: ["photos", "onSelect"], description: "A responsive grid of photo thumbnails." },
  { name: "Button", path: "ui/button.tsx", props: ["label", "loading"], description: "A pressable control." },
  { name: "EmptyState", path: "ui/empty-state.tsx", props: ["message"], description: "Says a list has no rows." },
];

test("tokensOf splits camel case, digits and separators, drops filler words and a plural s", () => {
  assert.deepEqual(tokensOf("PhotoGridView"), ["photo", "grid", "view"]);
  assert.deepEqual(tokensOf("the photos of a user-list"), ["photo", "user", "list"]);
  assert.deepEqual(tokensOf("HTMLParser2"), ["html", "parser", "2"]);
});

test("a name match outranks a description or prop match", () => {
  const found = findComponents(entries, ["grid"]);
  assert.equal(found[0].entry.name, "PhotoGrid");
});

test("the description and the prop names count", () => {
  assert.equal(findComponents(entries, ["confirm", "destructive"])[0].entry.name, "ConfirmDialog");
  assert.equal(findComponents(entries, ["loading"])[0].entry.name, "Button");
});

test("an entry that shares no token is not returned, and the list is capped at eight", () => {
  assert.deepEqual(findComponents(entries, ["zebra"]), []);
  const many = Array.from({ length: 20 }, (_, index) => ({ name: `Card${index}`, path: `c${index}.tsx`, props: [], description: "" }));
  assert.equal(findComponents(many, ["card"]).length, 8);
});

test("equal scores keep a stable order by name", () => {
  const found = findComponents(
    [
      { name: "BCard", path: "b.tsx", props: [], description: "card" },
      { name: "ACard", path: "a.tsx", props: [], description: "card" },
    ],
    ["card"],
  );
  assert.deepEqual(found.map((one) => one.entry.name), ["ACard", "BCard"]);
});

test("formatFound prints name, path and description", () => {
  const [one] = findComponents(entries, ["button"]);
  assert.equal(formatFound(one), "Button — ui/button.tsx — A pressable control.");
});
