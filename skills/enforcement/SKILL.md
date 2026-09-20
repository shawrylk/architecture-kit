---
name: enforcement
description: Every rule beside the check that enforces it, and what to do when one fails. Use when a gate, lint rule or hook blocks an edit, when adding a new rule, or when deciding whether something should be a rule at all.
---

# Enforcement

A rule that cannot name its check is deleted or converted into one — QC-007.

## The layers

| Layer | Mechanism |
|---|---|
| Types | Features are built only through `define*`. A wrong shape does not compile |
| Generators | `qc feature` scaffolds; codegen writes every shared registry |
| Lint | `error`, thresholds imported from `quality-thresholds.json` |
| Hooks | post-edit (fast, per file), stop (full, blocks a red turn), `.githooks/pre-commit` |
| CI | Required for merge |

`docs/enforcement.md` in the repository carries the full rule-to-check map. Read it when a gate
fails; it names the check for every rule.

## Commands

```bash
npx qc check          # every structural gate
npx qc check <file>   # the fast per-file path
npx qc config         # the configuration in force, after defaults are merged
```

## Adding or changing a rule

- Every rule and gate ships a case that **must fail** — ADR-0032. A gate that has never failed has
  never been tested.
- A threshold lives in `quality-thresholds.json` and nowhere else. Never restate a number in a
  comment, a doc, or a second config.
- **Never lower a gate ahead of the work it demands**: a gate that lands first blocks only the
  person doing that work.
- Turn a gate off in `qc.config.json` under `gates` or `rules` when the repository genuinely lacks
  what it checks. Do not weaken a gate that applies.

## When a hook blocks you

The hook output is a tool result, not advice — react to it. Fix the finding; do not edit the gate,
and do not disable the rule inline. If you believe the gate is wrong, say so and stop.
