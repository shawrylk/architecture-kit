# Guards

Three rules. They must not be "fixed" against each other.

| Operation | Guard | Why |
|---|---|---|
| Create | The client mutation id | The durable record is keyed on it; a repeated id is answered from the record. A multi-row create returns the full set. ADR-0050, ADR-0053 |
| Interactive update | The **version check**, not the id | The server does not resume an update from the ledger: the row may have moved between submissions, so replaying the old result would hide the move. ADR-0052 |
| Offline replay | Last-write-wins on the server clock | An offline client cannot be told to refetch. The losing value is kept for audit. ADR-0051 |

- A stale update is `conflict`. The error carries **no** fresh state — the client refetches and
  re-applies as a new operation with a new id.
- An update pipeline therefore needs no `ledger.ts`.
- The client mutation id stays required on every mutating request regardless: the outbox receipt and
  the audit trail key on it.

**Also do not "reconcile" these:** the database notification channel is rejected for durable
workflows and adopted for realtime fan-out. Both are correct — realtime frames are non-durable and
recoverable by sequence number. ADR-0016, ADR-0048.

Why this page exists: each guard looks like a special case of the others, and each time someone
unifies them a real bug comes back. If you are about to make two of these the same mechanism, that
is the thing this page is asking you not to do.
