# Architecture

## Layers — ADR-0001

**This is vertical slices over a thin shared kernel, not a layered application.** Most of the code
is in `features/`; the numbered directories hold a fraction as much, and they exist to keep the
shared substrate's dependencies pointing one way. Read `features/` first — the layers are what it
stands on, not where the system lives.

The domain layer is a shared package, imported by both surfaces so an invariant cannot diverge
between them; there is no per-surface domain directory.

`infrastructure` → `adapters` → `application` → `domain`. One legal direction, enforced by lint
because the compiler cannot.

| Layer | May import | Never |
|---|---|---|
| `domain` | nothing | any package, any framework, any I/O |
| `application` | `domain`, the validator | SDKs, the web framework, the ORM, env |
| `adapters` | `application`, `domain`, vendor SDKs | the web framework, the container, a peer-capability adapter |
| `infrastructure` | everything | — |

Ports take the `I` prefix. Nothing else does.

The layer set is `layers` in `qc.config.json`. A repository with different layers replaces the whole
block; a repository with these layers changes nothing.

## Feature anatomy — ADR-0047, ADR-0054

Features adopt one of two verified anatomies. Which one a feature may use is `anatomy` in
`qc.config.json`; `sliceOnlyRoots` names the roots where the flat anatomy is no longer allowed.

### Anatomy selection policy

- **Bounded Vertical Slices (ADR-0054)**: multi-operation features with several workflows or
  endpoints must adopt this layout. Operations are partitioned into discrete vertical slices to keep
  context bounded, avoid oversized files, and let people and agents change the feature concurrently
  without merge conflicts.
- **Flat pipeline (ADR-0047)**: narrow, single-operation features whose logic fits one coherent
  pipeline may keep the flat anatomy.

### Bounded Vertical Slices — ADR-0054

Scaffolder: `qc feature <domain-name>`.

| Path | Required | Owns |
|---|---|---|
| `index.ts` | yes | Public surface. The only file another feature imports |
| `schema.ts` | yes | DDL, tables, indexes. The only file defining schema |
| `trigger.ts` | yes | Thin composition point: maps routes to slice handlers |
| `slices/<action>.ts` | yes | Discrete operation: input validation, pipeline, and write |
| `shared/types.ts` | when needed | Row types, domain interfaces, column projections |
| `shared/queries.ts` | when reused | Common lookups imported by multiple slices |
| `shared/guards.ts` | when reused | Access checks, standing invariants, domain validations |
| `shared/runner.ts` | when needed | Pipeline runner execution helper |

Subfolders are restricted to `slices/` and `shared/`. Files under `shared/` are limited to the four
taxonomy roles above. Disallowed subfolders, unknown shared files, or empty slices fail review.

### Flat pipeline — ADR-0047

One block, one file. No subfolders. Scaffolder: `qc feature <domain-name> --flat`.

| File | Required | Owns |
|---|---|---|
| `index.ts` | yes | Public surface. The only file another feature imports |
| `trigger.ts` | yes | Routes, queue handlers, timers |
| `pipeline.ts` | yes | Ordered named steps |
| `resource.ts` | yes | Queries, writes, schema slice. The only block touching storage |
| `branch.ts` | when a flow splits on domain state | Conditional sub-flows |
| `fragment.ts` | when steps are reused in-feature | Named step groups |
| `ledger.ts` | when history outlives the rows | Append-only step history |
| `record.ts` | when the feature has an aggregate | The aggregate and its invariants |

An empty block is a review finding. A feature that needs one more file is split. Cross-feature reuse
is a kernel fragment, requested from the orchestrator.

## Unit of work

One step, one unit of work, one transaction.

- Repositories are built from the unit of work, never from the pool.
- The ledger append and any outbox insert enlist in the same unit of work.
- Repositories and sagas are `scoped`, never `singleton`.
- Reads outside a write take the reader pool; the writer is the default — ADR-0030.
- Raw SQL on a user-input path is a Critical finding.

## Composition root

The one place that names a concrete dependency. It builds the container and the route table; nothing
below it constructs a dependency for itself.

- Routes come from feature indexes only. Codegen writes the index list, the root mounts it, and an
  index that publishes no `trigger` fails at construction rather than at the first request.
- A route declares `auth`. A `tenant` route gets a verified principal before its handler runs; a
  `public` route declares itself a trust boundary and gets none, and no write path.
- Anything carrying a tenant is `scoped`, built from the request's principal. A `tenant` handler
  receives a unit of work already bound to its own tenant, so it cannot name another.
- Cache lifetimes come from the lifetimes registry, never a literal.
- The API enqueues; it never consumes. A worker's own entrypoint polls its queue — ADR-0016 — so a
  feature's `trigger` declares routes, and the enqueue seam is a port.
- A worker reports its outcome back through an `internal` route: no user principal, authenticated by
  a shared key compared in constant time, carrying the tenant the API put in the queue message. The
  key reaches the task through its secrets block. A browser can never reach one of these, and a
  worker can never reach a `tenant` route.

## Data

- The tenant column is on every business table; composite indexes lead with it.
- Isolation is three independent levels: repository predicate, row-level security, and a two-tenant
  test asserting zero cross-reads. A repository without that test fails review. The predicate is also
  checked structurally, across every feature at once — a statement on a business table that names no
  tenant fails the build, including the one nobody wrote a test for.
- Keyset pagination only, with an opaque cursor — ADR-0055. `docs/pagination.md` owns the query,
  the index, counting, and the one exemption.
- Migrations are generated, reviewed like code, never edited after merge, expand/contract only, and
  run as a one-off task before the service update — never on boot. The ledger holds each file's
  checksum, so an edited file fails the task instead of drifting.
- Row-level security is generated from the schema slices that declare a tenant column, and re-applied
  after every migration. It is never ledgered: the file changes whenever a feature is added, and
  every statement in it is idempotent. No work order edits a shared policy file.
- Object keys start with the tenant. Presigned lifetimes are a closed set.
- Errors: `{ code, message, requestId, details }`. Domain code throws; one handler maps — ADR-0044.
- The audit log is append-only. No repository has an update or delete path for it.

## Auth — QC-002, QC-003, ADR-0037

The browser holds a session cookie and never a token.

- The edge service completes the code exchange, keeps tokens server-side, issues a `__Host-` session
  cookie (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`), and proxies to the API with the bearer.
- The API is bearer-only and knows nothing about cookies, so a native client needs no API change.
- The session store is the one database — ADR-0010.
- CSRF: `SameSite=Lax` plus an `Origin` allow-list on every mutating handler. No `GET` mutates.
- A route the API serves without a session is unreachable unless the edge forwards it without one.
  The edge holds that closed set, a gate asserts it equals the set of `auth: "public"` routes, and a
  public route is forwarded with no `Authorization` header at all — a caller's own bearer is stripped
  with the hop-by-hop headers, never merely overwritten.
- **One origin, and it is load-bearing.** The `__Host-` prefix requires `Secure`, `Path=/` and no
  `Domain`, so the app and the edge must share an origin or the browser drops the cookie and every
  request is silently unauthenticated. The CDN serves the app and routes the edge prefix to the load
  balancer. On that prefix the CDN forwards cookies, `Origin`, `Authorization`, `Upgrade` and
  `Connection`, caches nothing, and allows every method — a cached authenticated response is a
  session leak, a stripped `Origin` fails the CSRF guard, and a stripped `Upgrade` fails the socket.
- The socket upgrade uses a single-use ticket minted by the edge and verified by the API, which binds
  the connection to the user before admitting it. Its lifetime lives in the lifetimes registry.
- A token with no organization claim is rejected before any handler runs. Revocation is read on every
  request from the tenant mirror — no denylist, no shared cache.

## Headless-first and sagas — QC-010

Every multi-step or business workflow is designed headless-first:

- Workflows are executable commands or pipeline sagas.
- UI components are thin presenters: views gather input and invoke the headless saga, never embedding
  orchestration in event handlers.
- Sagas define discrete steps, idempotency replay keyed on the mutation id, and backward compensation
  when an intermediate step fails.
- Complete scenarios run and verify headlessly via CLI or test runner in milliseconds, eliminating
  fragile browser automation.
- Browser automation is confined to smoke checks: visual token application, input-method composition
  guards, and canvas mount.

## Realtime — ADR-0048

The stream is sequenced. Every frame carries a sequence number and names a row.

- A client holding the **complete set** applies the frame as a delta.
- A client holding a **window** onto a set — anything paginated — invalidates and refetches,
  because a new row has no placement in a page nobody has fetched.
- A gap in the sequence is closed by refetching, never by guessing.
- Authorization is per subscriber: a frame carrying data must be filtered for the connection
  that receives it, which the refetch path gets for free by going through the normal read.

## Shared packages

The domain package is `domain`, imported by both surfaces, so invariants cannot diverge. The kernel
holds the runner and fragments — one implementation, wired in twice. The contracts package is
generated — ADR-0020.
