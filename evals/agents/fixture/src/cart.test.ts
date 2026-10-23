import { test } from "node:test";
import assert from "node:assert/strict";
import { addItem, subtotal, total, type Cart } from "./cart.ts";

const empty: Cart = { lines: [] };

test("addItem merges lines for the same sku", () => {
  const cart = addItem(addItem(empty, "BK-001"), "BK-001", 2);
  assert.deepEqual(cart.lines, [{ sku: "BK-001", qty: 3 }]);
});

test("addItem rejects an unknown sku", () => {
  assert.throws(() => addItem(empty, "BK-999"), /unknown sku/);
});

test("subtotal uses the sale price", () => {
  const cart = addItem(addItem(empty, "BK-001"), "BK-002");
  assert.equal(subtotal(cart), 4999 + 3999);
});

test("total without a code equals the subtotal", () => {
  const cart = addItem(empty, "BK-006", 2);
  assert.equal(total(cart), 11998);
});
