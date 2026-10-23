import { effectivePrice, findBook } from "./catalog.ts";
import { roundCents, type Cents } from "./money.ts";

export interface CartLine {
  sku: string;
  qty: number;
}

export interface Cart {
  lines: CartLine[];
  discountCode?: string;
}

export interface Discount {
  code: string;
  percent: number;
  // Sale items are already reduced, so most codes skip them.
  appliesToSaleItems: boolean;
}

const discounts: Discount[] = [
  { code: "WELCOME10", percent: 10, appliesToSaleItems: false },
  { code: "STAFF25", percent: 25, appliesToSaleItems: true },
];

export function findDiscount(code: string): Discount | undefined {
  return discounts.find((discount) => discount.code === code.toUpperCase());
}

export function addItem(cart: Cart, sku: string, qty = 1): Cart {
  if (!Number.isInteger(qty) || qty <= 0) throw new Error(`invalid quantity: ${qty}`);
  const book = findBook(sku);
  if (!book) throw new Error(`unknown sku: ${sku}`);
  const existing = cart.lines.find((line) => line.sku === sku);
  const lines = existing
    ? cart.lines.map((line) => (line.sku === sku ? { ...line, qty: line.qty + qty } : line))
    : [...cart.lines, { sku, qty }];
  return { ...cart, lines };
}

export function subtotal(cart: Cart): Cents {
  let total = 0;
  for (const line of cart.lines) {
    const book = findBook(line.sku);
    if (!book) continue;
    total += effectivePrice(book) * line.qty;
  }
  return total;
}

export function discountAmount(cart: Cart): Cents {
  if (!cart.discountCode) return 0;
  const discount = findDiscount(cart.discountCode);
  if (!discount) return 0;
  let discountable = 0;
  for (const line of cart.lines) {
    const book = findBook(line.sku);
    if (!book) continue;
    discountable += book.price * line.qty;
  }
  return Math.floor((discountable * discount.percent) / 100);
}

export function total(cart: Cart): Cents {
  return roundCents(subtotal(cart) - discountAmount(cart));
}
