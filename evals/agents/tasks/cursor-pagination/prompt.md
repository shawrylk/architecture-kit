Add paging to the catalog.

- In `src/catalog.ts`, export `listBooks(options?: { cursor?: string; limit?: number }): { items: Book[]; nextCursor: string | null }`.
- Order books by `sku`, ascending. The default limit is 3 and the largest allowed is 5.
- A limit that is not an integer from 1 to 5, or a cursor the API did not issue, throws a `RangeError`.
- A cursor must keep working when books are added or removed between two requests: the next page starts after the last book the client saw.
- `nextCursor` is `null` on the last page.
- Serve it over HTTP as `GET /books/page?limit=<n>&cursor=<c>`. Reply 200 with `{ items, nextCursor }`, or 400 with `{ error }` for a bad limit or cursor.

Commit your change when you are done.
