import { test } from "node:test";
import assert from "node:assert/strict";
import { addItem, CartError, removeItem, type Cart, type CartErrorCode } from "./cart.ts";

const start = (): Cart => addItem(addItem({ lines: [] }, "BK-001", 3), "BK-002", 1);

const codeOf = (fn: () => unknown): CartErrorCode | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof CartError) return error.code;
    throw error;
  }
  return undefined;
};

test("hidden: removeItem takes part of a line and keeps the old cart", () => {
  const before = start();
  const after = removeItem(before, "BK-001", 2);
  assert.deepEqual(after.lines, [{ sku: "BK-001", qty: 1 }, { sku: "BK-002", qty: 1 }]);
  assert.deepEqual(before.lines, [{ sku: "BK-001", qty: 3 }, { sku: "BK-002", qty: 1 }]);
});

test("hidden: removeItem without qty or with too much drops the line", () => {
  assert.deepEqual(removeItem(start(), "BK-001").lines, [{ sku: "BK-002", qty: 1 }]);
  assert.deepEqual(removeItem(start(), "BK-001", 7).lines, [{ sku: "BK-002", qty: 1 }]);
});

test("hidden: errors carry their codes", () => {
  assert.equal(codeOf(() => removeItem(start(), "BK-005")), "NOT_IN_CART");
  assert.equal(codeOf(() => removeItem(start(), "BK-001", 0)), "INVALID_QTY");
  assert.equal(codeOf(() => removeItem(start(), "BK-001", 1.5)), "INVALID_QTY");
  assert.equal(codeOf(() => addItem({ lines: [] }, "BK-999")), "UNKNOWN_SKU");
  assert.equal(codeOf(() => addItem({ lines: [] }, "BK-001", -2)), "INVALID_QTY");
  assert.throws(() => addItem({ lines: [] }, "BK-999"), /unknown sku/);
  assert.ok(new CartError("NOT_IN_CART", "x") instanceof Error);
});

// Type-level checks: tsc fails if CartErrorCode is wider than the three codes.
const known: CartErrorCode = "NOT_IN_CART";
// @ts-expect-error an unknown code is not a CartErrorCode
const unknown: CartErrorCode = "SOMETHING_ELSE";
void known;
void unknown;
