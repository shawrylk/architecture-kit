# Brief: <issue title>

Worktree: `<absolute worktree path>`
Branch: `<type>/<issue>-<slug>`
Issue: `#<issue>`
Report: `<absolute report file>`
Progress: `<absolute progress file>`
Paths: `<owned files or folders>`
Verify: none
Live: none
Approved: `<scout report; required for implement only when codex.requireApproval is true>`

## Product decisions

- <each ruling of the user that binds this task, or `none` with the reason>

## Design

- Files to change / new files: <paths and ownership; orchestrator writes this section>
- Signatures and new dependencies: <exact signatures and package names, or none>
- Copy evidence: <existing file:line to follow; see docs/architecture.md>

## Task

1. <the single task's exact change, owned paths, and cause; use at most six numbered steps>

## Run shape

1. Merge `origin/<base>` first. When the merge brings a migration with one of this branch's numbers, run `npx qc migrations renumber --onto origin/<base>`, then the code generator.
2. Write every item first, each test first. Run only the touched test files while you work.
3. Wrap each heavy command in `npx qc gate-slot --`: the local check, a test run of more than one file, a browser test, a live database test, a commit, and a push.
4. When you touch server code, run its live database tests before the push: `npx qc gate-slot -- npx qc throwaway-db -- <test command>`. Never use port 5432 or another port the local stack owns. When `check.e2e` is set, also run `npx qc gate-slot -- npx qc throwaway-db -- npx qc e2e` before the push.
5. In a batch, push the branch and open no pull request.

## Commit

`<type>(<scope>): <summary>`, body `Refs #<issue>`. No Claude co-author trailer, unless `commitMessage.attribution` in `qc.config.json` is on.

## Exit criteria

- Typecheck, the named test files, and the local check pass.
- The branch is pushed.
- Write the runner's marker as the last line, alone, only when the exit criteria hold.
- The last non-empty progress line must equal the marker exactly, after trimming whitespace.
- Never quote the marker elsewhere or wait for anyone to supply it; the runner supplies it in every prompt.
