import { test } from "node:test";
import assert from "node:assert/strict";
import { allBooks, listBooks, replaceCatalog, type Book } from "./catalog.ts";
import { route } from "./http.ts";

const original: Book[] = allBooks().map((book) => ({ ...book }));
const reset = () => replaceCatalog(original.map((book) => ({ ...book })));
const skus = (books: Book[]) => books.map((book) => book.sku);

test("hidden: pages walk the catalog in sku order", () => {
  reset();
  const first = listBooks();
  assert.deepEqual(skus(first.items), ["BK-001", "BK-002", "BK-003"]);
  assert.ok(first.nextCursor);
  const second = listBooks({ cursor: first.nextCursor ?? undefined, limit: 5 });
  assert.deepEqual(skus(second.items), ["BK-004", "BK-005", "BK-006", "BK-007", "BK-008"]);
  assert.equal(second.nextCursor, null);
});

test("hidden: a cursor survives a removal before it", () => {
  reset();
  const first = listBooks({ limit: 3 });
  replaceCatalog(original.filter((book) => book.sku !== "BK-001").map((book) => ({ ...book })));
  const second = listBooks({ cursor: first.nextCursor ?? undefined, limit: 2 });
  assert.deepEqual(skus(second.items), ["BK-004", "BK-005"]);
  reset();
});

test("hidden: a cursor survives an insertion before it", () => {
  reset();
  const first = listBooks({ limit: 2 });
  replaceCatalog([{ sku: "BK-000", title: "New", author: "A", price: 100, stock: 1 }, ...original.map((book) => ({ ...book }))]);
  const second = listBooks({ cursor: first.nextCursor ?? undefined, limit: 2 });
  assert.deepEqual(skus(second.items), ["BK-003", "BK-004"]);
  reset();
});

test("hidden: bad limits and cursors throw RangeError", () => {
  reset();
  for (const limit of [0, 6, 2.5, -1]) assert.throws(() => listBooks({ limit }), RangeError);
  assert.throws(() => listBooks({ cursor: "garbage!!" }), RangeError);
});

test("hidden: GET /books/page serves pages and rejects bad input", () => {
  reset();
  const ok = route("GET", new URL("/books/page?limit=2", "http://localhost"));
  assert.equal(ok.status, 200);
  const body = ok.body as { items: Book[]; nextCursor: string | null };
  assert.deepEqual(skus(body.items), ["BK-001", "BK-002"]);
  const next = route("GET", new URL(`/books/page?limit=2&cursor=${encodeURIComponent(body.nextCursor ?? "")}`, "http://localhost"));
  assert.deepEqual(skus((next.body as { items: Book[] }).items), ["BK-003", "BK-004"]);
  assert.equal(route("GET", new URL("/books/page?limit=9", "http://localhost")).status, 400);
  assert.equal(route("GET", new URL("/books/page?cursor=zzz", "http://localhost")).status, 400);
  assert.equal(route("GET", new URL("/books", "http://localhost")).status, 200);
});
