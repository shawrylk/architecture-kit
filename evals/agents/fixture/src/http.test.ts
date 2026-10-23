import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "./http.ts";

const get = (path: string) => route("GET", new URL(path, "http://localhost"));

test("GET /books lists the catalog", () => {
  const reply = get("/books");
  assert.equal(reply.status, 200);
  assert.ok(Array.isArray(reply.body));
});

test("GET /books/:sku finds one book", () => {
  assert.equal(get("/books/BK-001").status, 200);
  assert.equal(get("/books/BK-999").status, 404);
});

test("POST is not allowed", () => {
  assert.equal(route("POST", new URL("/books", "http://localhost")).status, 405);
});
