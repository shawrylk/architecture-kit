---
description: Run every architecture gate and explain any failure against the rule that owns it.
---

Run `npx qc check`.

If it fails, for each problem: name the gate, quote the rule from `docs/enforcement.md` that owns
it, and fix the code. Do not edit the gate, do not disable the rule inline, and do not lower a
threshold in `quality-thresholds.json` — if you believe a gate is wrong, say so and stop rather
than working around it.

If it passes, also run the repository's typecheck, lint and tests, and report the exemptions the
run printed: each one is a decision somebody made, and a growing list is worth surfacing.
