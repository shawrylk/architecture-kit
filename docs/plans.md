# Start from an approved plan

```sh
npx qc plan new 12 demo
# Fill in docs/plans/12-demo.md, then check it.
npx qc plan check docs/plans/12-demo.md
npx qc plan approve docs/plans/12-demo.md --by owner
npx qc plan status docs/plans/12-demo.md
npx qc plan revalidate docs/plans/12-demo.md '#13' --fits 2
npx qc plan done docs/plans/12-demo.md 2
```

Commit the plan on the task branch. Give the implement brief `Plan: docs/plans/12-demo.md`
and `Task: 2`. The plan path is relative to the brief's worktree.
After a compaction, use `qc plan status` to find the next open task.

## What a plan holds

The header has `Issue: #N`, `Status: draft`, and `Approved-by: none`.
The status is `draft`, `approved`, or `needs-approval`.
Use the sections Goal, Non-goals, Services, Catalog, Change log, and Tasks.
Each service has `Interface:` with a file in backticks and its methods,
`Now:` for the first implementation, and `Scale:` for the replacement and its trigger.
If no service changes, use `None: <reason>`. Search the catalog before you add a part.

Each `### Task N:` lists files with Create, Modify, Test, Delete, or Rename.
Add `(block: trigger)` under a feature root and `(~120 lines)` for the size after the change.
Use one responsibility per file and a service interface that a larger version can replace.
Use the eight blocks. A task has test steps and a commit step, each with a checkbox.
The default file limit is 500 lines. A task with `Split: <reason>` can exceed it.

## Check each new request

`qc plan new` writes the template. `check` checks the document. `status` shows progress.
`revalidate` records a request. `approve` records approval. `done` ticks one task.
The examples above show all six commands. The other request modes are:

```sh
npx qc plan revalidate docs/plans/12-demo.md '#14' --adds 'Fix copy' --files src/copy.mjs
npx qc plan revalidate docs/plans/12-demo.md '#15' --new-plan
npx qc plan revalidate docs/plans/12-demo.md '#16' --out 'Outside this feature'
```

An added task gets a stub. Fill in its steps before you start it.
A file named in Services, or a service added after approval, needs owner approval.
A `--fits` row needs no new approval. The lead can approve `None:` services with `--by lead`.
Approval is a record; it does not check a login. Run other approved tasks while you wait.

## The start gate and review

Set `codex.requirePlan: true` to require a plan. It is off by default.
The first implement run refuses a missing Plan line, a missing numeric Task line,
an unreadable plan or a path outside the worktree, a failed plan check,
a status other than approved, a missing task, a done task, or a Paths entry outside the task.
A folder in Paths passes if it holds a task file. Each refusal names the field or line to fix.
The gate reads one local file. It makes no network call.
Fix rounds with Proof, `--from-review`, and `--skip-implement` skip the start gate.
With the gate on, Plan meets `codex.requireApproval`; the brief still needs Design.
Codex must not edit the plan, even in a fix round. Such a run exits 4.

The review brief names the task, Services, and Catalog. It reports files outside the task
and files that grow past `plan.fileLines`. The plan and files of done tasks are not drift.
A task with Split gets no size note. On `DONE APPROVED`, the loop ticks the task
and commits only the plan. A task that is already ticked causes no commit.
