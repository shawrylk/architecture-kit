---
name: codex
description: Use only in a repository with `qc.config.json` to implement changes, review work, fix CI, and merge pull requests with Codex. Covers role briefs, launch commands, results, and fleet rules.
---

# Codex implementers

## Roles

Claude owns design, briefs, approval, CI, merges, and issues. Codex writes code and fixes. On exit 2, stop new starts and tell the owner.

## Scout, then approve, then code

1. Run `--role scout` for a read-only plan.
2. Check the report against the design. Record answers in `## Product decisions`.
3. For a breaking change or unresolved product question, run `npx qc ask --issue <n> "<question>"` and wait.
4. Supply `Approved: <report>` when `codex.requireApproval` is on. Run `--role implement`, or `--role tests` first.

## Write the brief

Copy `brief-template.md`. Keep these limits:

- At most 40 non-blank lines (`codex.briefMaxLines`) and six task steps (`codex.briefMaxSteps`), including nested steps. Up to `codex.maxRuns` sessions (default 2). Fixed headings and Run shape steps do not count.
- Put literal paths in backticks on `Paths:`, including tests. Name manifest dependencies in `## Design`. Implement/tests enforce these paths, dependencies, and `codex.maxDiffLines` (default 400).
- Name checks in backticks on `Verify:` and `Live:`, or use `none`.
- A review brief needs `Reviewed: <sha>` from the branch ledger and `Proof: <code report>`.
- Request a Claude co-author trailer only when `commitMessage.attribution` is on. Never tell Codex to skip a hook.

## Launch a run

Run in the background from the main checkout, with a worktree from `qc worktree add`:

```bash
npx qc codex-implement --brief <brief.md> --worktree <absolute worktree path> --progress <progress.md> --log <codex.log> [--role <role>] [--effort low|medium|high] > <wrapper.log> 2>&1
```

Use `*> <wrapper.log>` in PowerShell. Never call `codex exec` directly or start in the main checkout, scratchpad, or home folder. Review: `--review --report <file>`.

Run up to `swarm.dispatch.implementerSlots` jobs (default 3), with separate worktrees and paths. Keep more than 4 GB free per extra run. Use `--max-runs 2` for a second session and `--wait-reset` after a reset.

## Read the result

| Exit | Meaning | Next step |
|---|---|---|
| 0 | Done | Read report tail and diff |
| 1 | Bad input or missing `codex` | Fix command or brief |
| **2** | **Codex usage limit** | **Stop new starts; tell the owner** |
| 3 | Run limit or failed runner check | Read progress tail |
| 4 | Guard refused | Drop or rewrite refused commits; rotate remotely exposed secrets |
| 5 | Paused | Wait for the operator's `qc resume` |
| 7 | `Verify:` or `Live:` failed or timed out | Read report's `## Runner proof`; write a fix brief |

- Read only the tails of the progress file and the report. Never read the Codex log or a transcript.
- Read the diff of each test file yourself. A removed or weakened assertion is a finding.

## Review

Review each head once, then each fix increment with a fresh run and brief. Fold minor findings into that brief. `swarm.review.runtime` selects Codex or `architecture:sdd-branch-reviewer`.

## CI failures

- Read `gh run view <run id> --log-failed`. `qc watch` records failed tests.
- Fix briefs name each open test and `Cause:` under `## CI failures`. Two failing heads need `## Diagnosis`, `Root cause:`, and `Evidence:`.
- Three failing heads need `qc ask` with a `needs-user` issue question. Other branches continue.
- A green head resolves records. Add `Symptom:`, `Cause:`, and `Rule:` to `lessons.file` (default `docs/ci-lessons.md`).
- Rerun known flakes once: `gh run rerun <run id> --failed`. Ask the user if a runner stays offline. Never skip CI.

## Milestones and merge

- At `milestones.times`, run `npx qc milestone` to batch approved heads into one PR. Drop a member with `npx qc milestone --drop <branch>`.
- Stop for "no merge is authorized" in the PR body, a `qc pause --status` pause, or the `merge.holdLabel` label.
- Run `gh pr merge <n> --merge --match-head-commit <sha>`. Never use `--admin` or force-push.
- Confirm `MERGED`, close issues named with `Refs`, and run `npx qc worktree remove <name>`.
- After each merge, run `npx qc metrics`. File an issue for each rate worse than the previous period. Keep the run log local.

## Fleet

Without a fleet file, skip this section.

- Work only the issues that `npx qc fleet next` prints. Exit `3` means this PC has no free issue: stop and report.
- Push the issue branch right after `qc worktree add`, before the scout, so the other PCs see the issue as taken.
- Each PC merges only the heads it reviewed, because the ledger is local. Never name a PC in a branch, a commit, or a comment.
