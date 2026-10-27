import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("hidden: the guide explains the cart API and sale prices", () => {
  const guide = readFileSync(new URL("./cart-guide.md", import.meta.url), "utf8");
  assert.match(guide, /addItem/);
  assert.match(guide, /subtotal/);
  assert.match(guide, /sale price/i);
  assert.match(guide, /```typescript/);
});
