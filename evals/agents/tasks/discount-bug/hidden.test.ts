import { test } from "node:test";
import assert from "node:assert/strict";
import { addItem, discountAmount, total, type Cart } from "./cart.ts";

const cart = (code: string | undefined, ...lines: [string, number][]): Cart => {
  let next: Cart = { lines: [], discountCode: code };
  for (const [sku, qty] of lines) next = addItem(next, sku, qty);
  return next;
};

test("hidden: WELCOME10 rounds half away from zero", () => {
  assert.equal(discountAmount(cart("WELCOME10", ["BK-001", 1])), 500);
  assert.equal(total(cart("WELCOME10", ["BK-001", 1])), 4499);
});

test("hidden: WELCOME10 skips sale items", () => {
  assert.equal(discountAmount(cart("WELCOME10", ["BK-002", 1])), 0);
  assert.equal(total(cart("WELCOME10", ["BK-002", 1], ["BK-008", 1])), 3999 + 2999 - 300);
});

test("hidden: STAFF25 discounts the sale price", () => {
  assert.equal(discountAmount(cart("STAFF25", ["BK-002", 1])), 1000);
  assert.equal(total(cart("STAFF25", ["BK-002", 1])), 2999);
});

test("hidden: the code is case-insensitive and an unknown code gives nothing", () => {
  assert.equal(discountAmount(cart("welcome10", ["BK-008", 2])), 600);
  assert.equal(discountAmount(cart("NOPE", ["BK-008", 2])), 0);
});

test("hidden: rounding happens once on the whole discount", () => {
  // 10% of 3 x 4999 = 1499.7, which rounds to 1500.
  assert.equal(discountAmount(cart("WELCOME10", ["BK-001", 3])), 1500);
});
