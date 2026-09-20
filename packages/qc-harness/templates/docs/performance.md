# Performance

The one home for these numbers. Cite this file; never copy a figure into code, a comment or an
agent prompt. The no-number-in-comment rule exists to keep that true.

## Interaction budgets

A budget is about the **acknowledgement**, not the answer. Loading a large collection may take
seconds; showing that it started may not.

| Surface | Budget | Measured as |
|---|---|---|
| Any tap or click acknowledged | 100 ms | First visual change: pressed state, skeleton, optimistic row |
| Interaction to next paint (p75) | 200 ms | Web Vitals INP, collected in production |
| Longest task on the interface thread | 50 ms | Long-task observer; above it, split or move off-thread |

## Per-surface budgets

Replace this table with your own surfaces. Each row names a surface, a number, and the conditions
under which the number holds — a budget without conditions is not measurable.

| Surface | Budget |
|---|---|
| *(your list view, p95)* | *(number, at what size, with what query)* |
| *(your heaviest render)* | *(frame time, at what item count, on what device)* |
| *(your background worker)* | *(throughput per tenant; per-item p95)* |

## Rules

- Nothing over the long-task budget runs where the interface runs.
- Every list endpoint is keyset-paginated with a server-capped limit.
- Derivatives are made server-side. Client-side derivative generation is forbidden. ADR-0018.
- Lists holding hundreds of rows are virtualized.
- Optimistic by default on write, **except money and evidence**.
- A performance budget is not a quality gate: gates live in `quality-thresholds.json`.
