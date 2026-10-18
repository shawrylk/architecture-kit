# Brief: <issue title>

Worktree: `<absolute worktree path>`
Branch: `<type>/<issue>-<slug>`
Issue: `#<issue>`
Report: `<absolute report file>`
Progress: `<absolute progress file>`

## Product decisions

- <each ruling of the user that binds this task, or `none` with the reason>

## Task

<the exact change, the files, and the cause of a failure>

## Run shape

1. Merge `origin/<base>` first. When the merge brings a migration with one of this branch's numbers, run `npx qc migrations renumber --onto origin/<base>`, then the code generator.
2. Read at most 15 files before the first code edit. Research that needs more belongs to a planner, whose output this brief names.
3. Write every item first, each test first. Run only the touched test files while you work.
4. Then run the local check once, make one commit, and push once. Work up to about 200K tokens before a hand-off.
5. Wrap each heavy command in `npx qc gate-slot --`: the local check, a test run of more than one file, a browser test, a live database test, a commit, and a push.
6. When you touch server code, run its live database tests before the push: `npx qc gate-slot -- npx qc throwaway-db -- <test command>`. Never use port 5432 or another port the local stack owns.
7. Never skip a git hook. Never stop to ask: write the question in the report and continue.

## Commit

`<type>(<scope>): <summary>`, body `Refs #<issue>`. No Claude co-author trailer, unless `commitMessage.attribution` in `qc.config.json` is on.

## Exit criteria

- Typecheck, the named test files, and the local check pass.
- The branch is pushed.
- Write the runner's marker as the last line, alone, only when the exit criteria hold.
- The last non-empty progress line must equal the marker exactly, after trimming whitespace.
- Never quote the marker elsewhere or wait for anyone to supply it; the runner supplies it in every prompt.
