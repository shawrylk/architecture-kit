# Pagination

Keyset only. `offset` and `skip` are rejected — `qc/no-offset-pagination`.

Offset asks the database to walk past rows to reach the ones you want, so page one and page
five hundred cost different amounts, and the deeper the page the worse it gets. It is also
wrong under concurrent writes: a row inserted above the window shifts everything down, so the
reader sees a row twice or never.

Keyset asks a different question — *the rows after this one* — which is one index seek at any
depth, and stable while rows are inserted.

## The query, and the index that makes it free

```sql
create index on photos (tenant_id, captured_at desc, id desc);
```

```sql
select ... from photos
where tenant_id = $1
  and (captured_at, id) < ($2, $3)
order by captured_at desc, id desc
limit $4;
```

Three things decide whether this is a seek or a scan:

- **Row-value comparison.** `(a, b) < (x, y)`, never `a < x or (a = x and b < y)`. The first
  descends the composite index directly; the second frequently does not.
- **A unique tiebreaker.** Sorting on a timestamp alone silently skips or repeats rows whenever
  two rows share a value. The last column of the sort must be unique.
- **The index matches the sort exactly** — tenant first, then every sort column, same directions.

## The cursor is opaque, and that is load-bearing

The cursor is encoded and signed, never a readable pair of column values.

A cursor a client can read is a cursor a client will parse, and from then on the sort key is
public API: you cannot add a column to the ordering, change a direction, or migrate the key
without breaking every caller that learned to read it. Base-64 alone is not enough — it is
encoding, not opacity.

This follows both public standards. Relay's connection spec says a cursor "should be considered
opaque by the client". Google's AIP-158 is stronger: page tokens **must** be opaque and **must
not** be user-parseable, and calls base-64 explicitly insufficient.

## "How many are there?"

An exact count over a large collection is a full scan of the index, every request. Do not serve
one by default. In order of preference:

| | Cost | What it says |
|---|---|---|
| **Bounded count** | capped | "1,000+ results" |
| Estimate from table statistics | free | "about 12,000 results" |
| Exact `count(*)` | O(n) | "1,247 results" |
| Nothing | free | infinite scroll |

The bounded count is the default:

```sql
select count(*) from (
  select 1 from photos
  where tenant_id = $1 and folder_id = $2
  limit 1001
) capped;
```

Cost is capped whatever the collection holds, and below the cap the number is exact for free.

If the response carries a total, it is named as an estimate and documented as one. AIP-158
permits a `total_size` that "may be an estimate", provided the API says so. An undocumented
approximate count is worse than none.

## Jumping to a page

Keyset cannot do it. Finding the row at position nine hundred means walking nine hundred rows,
which is offset by another name.

Almost every real use of a page number is one of two things, and both have a better answer:

- **"take me to the end"** — reverse the sort and fetch the first page
- **"take me to around March"** — seek on the sort key, not on an ordinal. A date jump, an
  alphabet index, a filter. Same query shape, same index, no counting

Genuine ordinal paging belongs to paginated *deliverables* — a printed ledger, a regulatory
export — not to browsing. Where a surface truly needs it, AIP-158 sanctions a `skip` field that
returns an empty result set rather than a slow one. Here that is an exemption: a marked comment
carrying its reason, printed on every run, the way the tenant predicate handles its exceptions.

## The client

A keyset cursor maps onto an infinite query: the page parameter is the cursor, and the end of
the collection is the absence of a next one.

```ts
useInfiniteQuery({
  queryKey: ['photos', folderId],
  queryFn: ({ pageParam, signal }) => fetchPhotos(folderId, pageParam, signal),
  initialPageParam: null,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
  maxPages: 5,
})
```

`maxPages` bounds memory on a long scroll; it needs `getPreviousPageParam` to refetch in both
directions. A page-number interface is a different hook entirely — a plain query keyed on the
page — which is another reason not to build one.

**Invalidating an infinite query refetches every loaded page**, not the stale one. Ten pages
loaded is ten round trips per notification. Narrow the key, or apply the change in place when
the row is already loaded and refetch only when it is not — ADR-0048.
