# UI

## Parity

Visual parity with whatever this replaces is the default. Divergence is argued in the work order,
with a before and after.

## Presenters — QC-010

A view gathers input and invokes a headless workflow. It does not orchestrate. The
`no-orchestration-in-trigger` rule is what holds this: more than one `await` in a presenter is the
signal that a workflow belongs behind it.

## Realtime — ADR-0048

A frame names a row; the client invalidates and refetches. Frames carry notifications, not data, so
a missed frame costs a refetch rather than a divergence.

## Cancellation — ADR-0038

The cancellation token is the last parameter of every function that can outlive the interaction. A
write is never cancelled by navigation.

## Accessibility — ADR-0040

WCAG 2.2 AA. Every drag has a non-drag equivalent. The focus ring is never removed.

## Hot loops

Data-oriented discipline applies to any hot loop: per frame, or over a large item count, or
allocating per iteration on the interaction thread. Assert it by measuring allocation, not by
reading the code.
