# Decisions

Self-contained: every id cited in this repository's code or docs is defined here. A citation to an
id not listed below fails the citations gate.

Ids are stable. A decision is corrected in place before its first consumer and superseded by a new
id after it — ADR-0028. Numbers are not renumbered to close gaps: a gap is a decision that was
never portable, and renumbering would break every citation that already points here.

## Architecture

| id | decision | the rule it imposes |
|---|---|---|
| ADR-0001 | Four layers, one direction | `domain` imports nothing, not even a validator. `application` may import the validator. `adapters` never imports the web framework, the container, or a peer-capability adapter. Direction is enforced by lint, not by a naming convention and not by the compiler |
| ADR-0002 | One cloud | No provider abstraction layer |
| ADR-0010 | One database, no second datastore | No cache server, no search cluster. Sessions and caches live in the database |
| ADR-0016 | Queues for asynchronous work, no event bus | One consumer and one dead-letter queue per message. In-process domain events are a synchronous typed emitter |
| ADR-0020 | Contracts outrank prose | Validation schemas are generated from the contract, never hand-written beside it |
| ADR-0028 | Before the first consumer, a decision is corrected in place | After it, a change is a new id that supersedes |
| ADR-0030 | Reader and writer pools exist before a replica does | The writer is the default; a read joins the reader list only by being named |
| ADR-0031 | State machines are a client concern | Durable server state is columns plus a transition table |
| ADR-0046 | The database major is the current one | The registry is the pin; the minor comes from the cloud catalog at apply time |
| ADR-0047 | Every feature is a pipeline of named blocks | One block, one file. An empty block is a review finding. Only `index` crosses a feature boundary |
| ADR-0055 | Pagination is keyset, and its cursor is opaque | `offset` and `skip` are rejected. A total is a bounded count or a documented estimate, never an exact count by default. `docs/pagination.md` owns the query, the index and the exemption |
| ADR-0054 | Bounded vertical slices with prescribed taxonomy | Operations are discrete vertical slices under `slices/`; `index`, `schema`, `trigger` at root. Disallowed subfolders fail review |

## Correctness

| id | decision | the rule it imposes |
|---|---|---|
| ADR-0044 | A code is for a client that acts differently; a reason is for a person who reads | `code` is an enum the client switches on; `details[].rule` keys a localized message |
| ADR-0050 | The client mints one mutation id per user operation attempt | Persisted so a reload cannot lose it. A repeated id is a resume, not a new operation |
| ADR-0051 | Interactive edits are guarded by a version column | A mismatch is a conflict. Offline replay is excluded and stays last-write-wins |
| ADR-0052 | The version check is the double-apply guard for updates | An update pipeline needs no ledger. A repeated update is never answered by replaying the old result |
| ADR-0053 | A multi-row action is independent single-row operations | Partial success is the intended shape. A bulk resume returns the full set |

## Security and infrastructure

| id | decision | the rule it imposes |
|---|---|---|
| ADR-0029 | Three-tier private network | Only the load balancer is reachable. Security groups and network ACLs are two independent controls. No bastion, no SSH |
| ADR-0037 | The browser holds a session cookie and never an access token | The token lives server-side in the edge service |
| ADR-0011 | Media transfers are direct client-to-object-store | Bytes never pass through the API |
| ADR-0018 | Derivatives are made server-side | Client-side derivative generation is forbidden |

## Client

| id | decision | the rule it imposes |
|---|---|---|
| ADR-0038 | Client work is cancellable, off-thread and event-driven by construction | The cancellation token is the last parameter of every function that can outlive the interaction. A write is never cancelled by navigation |
| ADR-0040 | Accessibility is WCAG 2.2 AA | Every drag has a non-drag equivalent. The focus ring is never removed |
| ADR-0048 | Realtime is a sequenced stream, and a frame is applied only where the client holds the whole set | Every frame carries a sequence number and names a row. A client holding the complete set applies the frame as a delta; a client holding a window onto a set invalidates and refetches, because a new row has no placement in a page nobody has fetched. A gap in the sequence is closed by refetching, never by guessing. Fan-out is in-process first, then the database notification channel |

## Process

| id | decision | the rule it imposes |
|---|---|---|
| ADR-0032 | A gate is tested code | Every gate ships a case that must fail. A warning is not a check |

## Local decisions

Decisions this repository made on its own. New ids start at `QC-001`. The entries below are the
portable ones; delete any that do not apply and add your own rather than renumbering.

| id | decision | the rule it imposes |
|---|---|---|
| QC-001 | One responsive application, no separate mobile build | A screen adapts; it never forks into two implementations |
| QC-002 | The edge service is a thin service of its own | It owns the code exchange, the session store and the cookie. The API stays bearer-only |
| QC-003 | The realtime upgrade uses a single-use ticket minted by the edge | The API validates and binds the connection before admitting it |
| QC-007 | A rule that cannot name its check is deleted or converted into one | `docs/enforcement.md` carries the map |
| QC-008 | A change is rewritten in place, as if it had always been that way | No supersession trail, no deprecation note, no "what this replaces". The repository states what is true now; git holds the history |
| QC-010 | Headless-first command and saga architecture | Every multi-step workflow is an executable pipeline or command callable headlessly without a browser. UI components are thin presenters invoking these workflows. Headless tests verify state transitions, idempotency, and compensations |
