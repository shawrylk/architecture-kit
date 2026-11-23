# Architecture and copy patterns

This map is owned by the orchestrator. Scouts propose changes to it; implementers
follow the approved Design and name any missing precedent in their report.

| Area | Owner and direction |
|---|---|
| `packages/qc-harness/src/cli/` | Command parsing, process and Git adapters, user output; imports config and shared helpers. |
| `packages/qc-harness/src/config.mjs` | Defaults and configuration validation; commands consume it. |
| `packages/qc-harness/src/gates/` | Repository checks; use shared helpers and report findings. |
| `packages/qc-harness/src/glob.mjs` | Shared matching rules; imports no command. |
| `agents/` | Dispatch contracts; forward documented flags to the runner. |
| `skills/codex/brief-template.md` | Orchestrator's brief format; Design is an input to implementation. |
| `docs/reference.md` | User-facing command and configuration contract. |

Keep CLI adapters above shared policy. A shared helper must not import `qc.mjs`
or cause another command to run. `qc.mjs` routes commands with lazy imports.
Commands use `load(worktree)` for configuration and retain the initial guard policy
through a child run. Never let child edits weaken that policy.

Use these existing patterns when writing a Design:

- Runner lifecycle and exit handling: `src/cli/codex-implement.mjs`, relative to
  `packages/qc-harness/`; keep pause, CI, limit/reset and terminal exit behavior.
- Git protection and redaction: `src/cli/commit-guard.mjs`; preserve intermediate
  commit scanning and never print secret values in findings.
- Diff scope: `src/cli/diff-shape.mjs`; freeze the start HEAD, owned Paths,
  Design dependency names and line limit before the child starts. Include index,
  worktree and untracked files, both rename names, deletions and new manifests.
- Cross-platform child execution: `src/cli/spawn-command.mjs`; use an argument
  array and stdin for prompts, and set the worktree cwd explicitly on resume.
- Tests: sibling `*.test.mjs` files using `node:test`, temporary Git repositories
  and fake child commands. Clean temporary folders with recursive, force,
  maxRetries and retryDelay; run only the touched tests while implementing.

A Design names existing files to change, new files, exact signatures, added
package names (including aliases), and copy evidence as `file:line` pointers.
Use `none` with a reason where a field has no change. An implement brief needs
Design and a readable Approved report only when `codex.requireApproval` is true.
The orchestrator enables that setting after accepting the scout's plan.
Scouts write only external reports/progress and never modify the worktree.
Tests and implement runs both enforce the diff shape, even with approval off.
The default line limit is 400 added plus deleted lines; split larger issues.
