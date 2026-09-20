---
description: Scaffold a new feature in the repository's anatomy and fill in its first slice.
argument-hint: <domain-name> [--flat]
---

Scaffold the feature `$1` and implement its first operation.

1. Run `npx qc feature $ARGUMENTS`. The name is the full domain word, never a code or an
   abbreviation. Do not hand-build the folder — the generator is what makes a wrong anatomy
   impossible.
2. Read `docs/architecture.md` for the anatomy you were given, and `docs/glossary.md` for the
   term this feature is named after.
3. Fill in the generated files. An empty block or slice is a review finding: delete what this
   feature does not need rather than leaving a stub.
4. The first thing to finish is `index.ts` — types, query keys, method names, no bodies — because
   it is what other work orders are blocked on.
5. Add the two-tenant test asserting zero cross-reads before the feature is considered done.
6. Run `npx qc check` and the repository's typecheck and lint.
