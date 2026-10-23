---
description: Adopt the kit in this repository — scaffold the config, the decision register, the git hooks, and the CI workflow, then report what is left to decide.
---

Adopt the kit in the current repository.

1. Run `npx qc init`. It writes `qc.config.json`, an empty `docs/decisions.md`, the three hooks
   under `.githooks/`, and `.github/workflows/ci.yml`. It skips a file that exists.
2. Run `npx qc install-hooks`.
3. Replace the ESLint config with the preset of `architecture-harness/preset`.
4. Run `npx qc check`, `npx qc typecheck`, and `npx qc lint`, and fix what they report on the change.
5. Run `npx qc config` to see the configuration in force. Point `featureRoots` at the feature folders
   when `qc init` found none and the repository has some.

Run `npx qc init --full` only when the user asks for the reference architecture. It adds the docs, their
decisions, the quality thresholds, the PR policy workflow, and the Vale style. After it:

- `docs/decisions.md`: delete each decision that does not apply, and add the ones the repository
  already follows. Never renumber an id, because every citation points at its number.
- `docs/glossary.md` and `docs/performance.md`: replace them with the terms and budgets of the repository.

Report at the end: which gates are on, which are off and why, and what a person still needs to decide.
