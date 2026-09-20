---
description: Adopt the bounded vertical slice architecture in this repository — scaffold the decision register, the docs, the config, the git hook and the CI workflow, then report what is left to fill in.
---

Adopt this architecture in the current repository.

1. Run `npx qc init`. It writes `qc.config.json`, `quality-thresholds.json`, `.jscpd.json`,
   `docs/`, `.githooks/pre-commit` and `.github/workflows/ci.yml`, and leaves any file that
   already exists alone.
2. Run `npx qc install-hooks`.
3. Read the repository and fill in what the templates leave open:
   - `docs/decisions.md` — delete decisions that do not apply here, and add the ones this
     repository has already made implicitly. **Never renumber**: every citation points at a number.
   - `docs/glossary.md` — the real domain terms.
   - `docs/performance.md` — the per-surface budget table.
   - `CLAUDE.md` — the repository's own name and one-line purpose.
4. Point `qc.config.json` at this repository's layout wherever it differs from the reference:
   `featureRoots`, `paths`, `layers`, `tenant`, `apiClient`, `presenters`. Run `npx qc config` to
   see what is in force after defaults merge.
5. Turn off, in `qc.config.json`, the gates and rules for things this repository genuinely does not
   have — workers, an edge service, a contract directory. Do not weaken a gate that applies.
6. Run `npx qc check` and fix what it reports.

Report at the end: which gates are on, which are off and why, and what a human still needs to
decide (usually the decision register and the budget table).
