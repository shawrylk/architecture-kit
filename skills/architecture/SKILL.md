---
name: architecture
description: The bounded vertical slice architecture — layers, feature anatomy, unit of work, guards, and where each rule is written down. Use when adding or changing a feature, choosing where code belongs, deciding between slice and flat anatomy, or when a structural gate fails and the fix is not obvious.
---

# Architecture

Authority is `docs/decisions.md` in the repository you are working in. Every cited id is defined
there. If a doc this skill names does not exist, the repository has not run `qc init`.

## Read before changing a feature

| Concern | Read |
|---|---|
| Layers, feature anatomy, unit of work, data, auth | `docs/architecture.md` |
| Create / update / offline guards — **do not reconcile them** | `docs/guards.md` |
| Parity, realtime, presenters | `docs/ui.md` |
| Rule-to-check map, comment rules | `docs/enforcement.md` |
| Budgets | `docs/performance.md` |
| Keyset, cursors, counting | `docs/pagination.md` |
| Domain terms | `docs/glossary.md` |

## The shape

Vertical slices over a thin shared kernel. Most code is in `features/`; the numbered layer
directories exist only to keep the shared substrate's dependencies pointing one way:
`infrastructure` → `adapters` → `application` → `domain`. `domain` imports nothing.

A feature is one of two anatomies, and `qc check` tells you which one it is in:

- **Bounded vertical slices** — `index.ts`, `schema.ts`, `trigger.ts` at the root; one file per
  operation under `slices/`; `shared/` limited to `types`, `queries`, `guards`, `runner`.
- **Flat pipeline** — `index.ts`, `trigger.ts`, `pipeline.ts`, `resource.ts`, plus `branch`,
  `fragment`, `ledger`, `record` when earned. No subfolders.

Scaffold with `qc feature <domain-name>`; never hand-build the folder. An empty block or slice is a
review finding, so delete what the feature does not need rather than leaving a stub.

## Non-negotiable

- Only a feature's `index` crosses a feature boundary. Cross-feature reuse is a kernel fragment,
  requested from the orchestrator — never an edit into another feature's folder.
- The tenant column is on every business table; repositories are `scoped`, never `singleton`;
  row-level security; a two-tenant test asserting zero cross-reads.
- Keyset pagination only.
- Throw a domain error; never write an HTTP status by hand.
- The cancellation token is the last parameter of anything that can outlive the interaction.
- One module calls `fetch`.
- Never write a number or quantity threshold in a comment. Cite the registry or the doc that owns it.
- A change is rewritten in place: no supersession trail, no deprecation note (QC-008).

## When a gate fails

`qc check` names the gate and the file. The fix is in `docs/enforcement.md`, which lists every rule
beside the check that enforces it. Do not work around a gate, and do not edit a gate to make your
change pass — if a gate is wrong, say so and stop.
