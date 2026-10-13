# Changelog

## Harness 0.22.0 and plugin 0.15.0

- `qc codex-implement` refuses briefs above 40 non-blank lines or six numbered steps by default.
- Each brief requires a `## Product decisions` heading and a `Paths:` line, with at most one other `## ` heading.
- `--max-runs` defaults to one, and the runner refuses values above two by default.
- `codex.briefMaxLines`, `codex.briefMaxSteps`, and `codex.maxRuns` configure the limits in the worktree's `qc.config.json`.
- Each refusal reports the rule, the limit, and the measured value before Codex starts.

Split a larger brief into one task per session, and use `--max-runs 2` when the task needs a continuation.
