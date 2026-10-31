---
name: applying-engineering-standards
description: "Use when designing, writing, refactoring, or reviewing code: deciding where new behavior lives, adding a method to a broad class, writing a code comment, touching a hot path or a per-item loop, a state change that crosses a boundary, or dispatch by runtime type."
---

# Engineering standards

## Engineering Motto

Design and refactor work must follow these principles, in priority order (when two conflict, the higher one wins):

1. **Performance first on hot paths** — on code that runs per-frame / per-item / in tight loops, the faster choice wins. Avoid reflection, dynamic invocation, boxing, and allocation in inner loops.
2. **DRY — one mechanism per job** — no duplicated code, and no two *kinds* of machinery doing the same job. Many *instances* of one mechanism is fine; competing mechanisms for one responsibility is not.
3. **No mixing of concerns** — one responsibility per unit. Cross-cutting concerns (logging, tracing, throttling) are separate units, not baked into the core.
4. **KISS** — the simplest thing that works. No speculative abstraction; add generality only when a real use case exists.
5. **SOLID** — apply to cold / architectural code (services, wiring, interfaces).
6. **Feature-cohesive structure** — organize by feature with a strict dependency direction; features communicate through shared mechanisms (e.g. a message bus), not by reaching into each other. Don't slice purely by technical type.
7. **Dispatch precedence: generics / statically-typed delegates > compiled expression trees > reflection** — never use runtime reflection on hot/repeated paths. If dynamic-by-runtime-type dispatch is unavoidable, compile a delegate once per type and cache it.

**Hot/cold reconciliation rule:** enterprise OO (SOLID, DIP, interfaces) and data-oriented performance pull in opposite directions. Resolve with a **hot/cold split** — OO abstraction for cold architecture; flat data and no virtual dispatch inside the per-item hot path.

## Architecture patterns

Three patterns govern a coding task. They compose with the motto above. Where one appears to
restate a motto rule, the motto wins.

**Blocks.** Every unit of a system is exactly one of eight kinds: `index`, `pipeline`, `branch`,
`trigger`, `fragment`, `resource`, `record`, `ledger`.

- Name the kind in the design, before you write the unit.
- One unit carries one kind. A unit that answers to two kinds is two units, per motto #3.
- Group by feature, per motto #6. The kind is the unit's role, never its folder.
- The kind belongs in the unit's name or its docstring, so a reader classifies it without a guess.

**Saga.** A state change that crosses a boundary runs as a saga. Never open a distributed
transaction.

- Every step has one compensation that undoes it.
- The compensation is its own unit, not a branch inside the step, per motto #3.
- Persist each step's outcome, so a retry resumes rather than repeats the work.
- Key a step on the work it does, never on the attempt. A fresh key per attempt charges twice.

**ECS (entity-component-system).** Use it for the per-item hot path: an entity is an id, a component
is flat data, and a system is one loop over one component set.

- A component holds no behavior. A system loop makes no virtual call.
- The hot/cold reconciliation rule above decides where ECS stops and OO starts.

## Class Design — avoid god classes

- **Prefer small, cohesive classes over piling new methods onto an existing one.** Do not keep appending unrelated helpers to a broad utility class (e.g. a `CommonMethods` / `Utils` / `Helpers` grab-bag) — that grows a god class of unrelated methods that is hard to discover, use, and maintain.
- When adding behavior, put it with the **concern it belongs to**: a new small class named for that concern, or — if it has a single caller — a private helper on that caller. Add a new type when the concern is distinct; don't invent a thin one-method class when a single-use private helper is simpler (KISS).
- A focused class gaining a cohesive method is fine; a general-purpose dumping ground gaining an unrelated method is not.

## Comments & Language

The code speaks for itself. Write a comment only where the code cannot express the idea.
The timeless rule is **Timeless prose** in the `writing-plain-english` skill; the points below are how it reads in code.

For new code you write:

- Comments and identifiers: English only. Japanese only for UI strings, each with an English comment beside it.
- A comment says what the code cannot: why, an ordering dependency, a workaround. One line unless it earns more.
- A comment describes the code, never the progress of the project. This covers descriptions and error messages too.
  - No deployment state: "not applied yet".
  - No revision history: "an earlier revision said".
  - No dates: "measured on 2026-09-02".
  - No milestone ids. Keep an issue ref that names a decision. Drop one that tracks progress.
  - State a temporary constraint as the constraint, not the calendar.
- Short and plain, for a reader whose first language is not English. One idea per sentence. The rule before the reason.

Do not rewrite existing code only to comply.
