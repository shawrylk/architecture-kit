# ADR-NNNN — <the decision, as a claim, not a topic>

<!-- Copy to docs/decisions/ADR-NNNN-<slug>.md. Every heading below is required and checked by
     `qc check` (adr-format). Write in English. A heading with nothing under it fails. -->

| | |
|---|---|
| **Status** | proposed \| accepted \| corrected |
| **Decided** | YYYY-MM-DD |
| **Deciders** | who was in the room |
| **Register row** | the one line this expands, copied verbatim from `docs/decisions.md` |

## Prerequisite

What a reader must already know or have in place for this decision to make sense: the decisions it
builds on, the constraint that was already fixed, the system state it assumes. If someone would
reach a different conclusion without knowing X, X belongs here.

## Context

The forces in tension when this was decided. Requirements, constraints, deadlines, team size, what
was already built. Facts only -- no advocacy. A reader must be able to disagree with the decision
while accepting every sentence in this section.

## Decision

One paragraph, in the present tense, stating what is true now. This is the claim the register row
summarises, and code cites this id because of this paragraph.

## Why this, specifically

The reasoning from the context to the decision. Not the benefits -- the argument. Which force
dominated, and why it outweighed the others that pulled the other way.

## What this buys

The concrete benefits, each one something a reader could check later. "Simpler" is not a benefit;
"one place to change a tenant predicate instead of nine" is.

## What this costs

The price paid, honestly. Every real decision has one. An ADR with an empty cost section is
advocacy, not a record -- and the reviewer's first question is what it left out.

## Alternatives considered and not chosen

One subsection per alternative that was genuinely on the table. An alternative nobody considered
does not belong here; padding this section with straw men is worse than leaving it short.

### <alternative>

What it was, and the specific reason it lost. If it lost on a measurement, name the number. If it
would win under different conditions, say which -- that is the trigger to revisit this decision.

## Related decisions

The ids this depends on, constrains, or is in tension with, each with one line on the relationship.
Every id must resolve in `docs/decisions.md`, or the citations gate fails.
