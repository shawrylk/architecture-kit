# Fast and trusted workflow: implementation plan

> **For agentic workers:** each task below is one GitHub issue. The issue runs the workflow this plan builds: scout run, orchestrator approval, test run, code run, runner tests, Codex review. Until task 3 lands, use the current `qc codex-implement` flow with a test-first brief.

**Goal:** the runner, not the model, proves each change. The orchestrator owns the design. Merges go to `main` in two or three milestones each day.

**Architecture:** extend `qc codex-implement` with roles (`scout`, `tests`, `implement`, `review`) and post-run checks. Add `qc milestone` and `qc overview`. Move the merge guard to accept Codex review verdicts. Cut prose rules that no code enforces.

**Tech stack:** Node 22 ES modules, `node --test`, `gh`, `git`, Codex CLI.

**Spec:** `docs/superpowers/specs/2026-11-23-fast-trusted-workflow-design.md`

## Global constraints

- Codex `gpt-6.1-sol` writes and reviews. Review effort is `high`.
- Every new setting has a default in `packages/qc-harness/src/config.mjs` and a line in `templates/docs/enforcement.md`.
- Every refusal names the rule and its limit in at most four lines.
- A new exit code is never reused. Exit 4 stays "guard refused".
- No security, tenant, data, or correctness check is removed.
- All text follows the plain-language rules of the repository.

## Review focus

1. A brief from before this change (no `## Design`, no `Approved:`): the runner refuses it with a message that names the missing line, never a stack trace.
2. A locked test file renamed or deleted by the code run: this counts as a change and is refused.
3. A milestone where one branch conflicts and two are clean: the clean two still merge.
4. Windows paths in `Paths:` and in the locked-test hashes: the checks compare normalized forward-slash paths.
5. A Codex review report with no `VERDICT:` line: the runner records nothing and exits 3, so the merge guard stays closed.

---

### Task 1: the model pin and the Codex review verdict

**Files:**
- Modify: `packages/qc-harness/src/cli/codex-implement.mjs` (`runJob`, `parseArgs`, `codexSettingsOf`)
- Modify: `packages/qc-harness/src/config.mjs` (codex defaults, `reviewDefaults`)
- Modify: `packages/qc-harness/src/cli/merge-guard.mjs` (`mergeVerdict` kinds)
- Modify: `agents/codex.md` (dispatch names a `Report:` line)
- Test: `codex-implement.test.mjs`, `merge-guard.test.mjs`, `config.test.mjs`

**Interfaces:**
- Produces: `codex.model` (default `null`: keep the Codex config), `codex.reviewModel` (default `"gpt-6.1-sol"`), `codex.reviewEffort` (default `"high"`).
- Produces: `--report <file>` flag. With `--review`, the runner reads the first `VERDICT: (APPROVED|CHANGES_REQUIRED)` line of the report and appends `{ type: "verdict", kind: "codex", verdict, sha, branch, scope? }` to the ledger. `sha` is the worktree `HEAD`.
- Produces: `swarm.review.runtime`: `"claude"` (default) or `"codex"`. With `"codex"`, the merge guard counts `kind: "codex"` verdicts as well as the `swarm.review.merge` kind.

**Tests:**
- `codex.model set → args hold -c model="<value>"`; unset → no `model=` arg.
- `--review uses codex.reviewModel and codex.reviewEffort`.
- `review report with VERDICT: APPROVED → one codex verdict record on HEAD`.
- `review report with no VERDICT line → no record, exit 3`.
- `merge guard with runtime codex accepts an APPROVED codex verdict on the head`; with runtime `claude`, refuses it.

**Verify:** `node --test packages/qc-harness/src/cli/codex-implement.test.mjs packages/qc-harness/src/cli/merge-guard.test.mjs` passes. Set `codex.model` to `gpt-6.1-sol` in this repo's `qc.config.json`, and restore the user's `~/.codex/config.toml` from the backup.

### Task 2: the scout run, the approval line, and the diff shape check

**Files:**
- Modify: `codex-implement.mjs` (`validateBrief`, new `--role`), new `packages/qc-harness/src/cli/diff-shape.mjs`
- Create: `docs/architecture.md` (the module map of this kit, at most 150 lines)
- Modify: `skills/codex/brief-template.md`
- Test: `codex-implement.test.mjs`, new `diff-shape.test.mjs`

**Interfaces:**
- Produces: `--role <scout|tests|implement|review>`. `--review` stays as an alias for `--role review`.
- Scout: the prompt forbids edits. The runner refuses (exit 4) any commit or dirty file after a scout run. The report must hold the lines `Root cause:` or `Gap:`, `Plan:`, `Check:`, `Risks:`, `Questions:`, `Breaking: yes|no`. A missing line gives exit 3.
- Implement: the brief must hold `## Design` and `Approved: <path>` with an existing file. Else exit 1 with the missing line named.
- `checkDiffShape({ worktree, base, paths, design, maxDiffLines }) → { problems: string[] }`. Problems: a file outside `paths`, a new `dependencies` or `devDependencies` key not named in `design`, more than `maxDiffLines` changed lines.
- `codex.maxDiffLines` default `400`.
- `--resume <session id>`: runs `codex exec resume <id>`. The runner prints `session <id>` in the wrapper log after each run.

**Tests:**
- `scout run that commits → exit 4`.
- `scout report without Breaking: → exit 3`.
- `implement brief without Approved: → exit 1 naming Approved:`.
- `diff shape: file outside Paths → one problem naming the file`.
- `diff shape: 401 changed lines → one problem with "split the issue"`.
- `diff shape: Windows backslash path inside Paths → no problem`.

**Verify:** the named test files pass. `qc check` passes.

### Task 3: the test run, locked tests, and runner-run tests

**Files:**
- New: `packages/qc-harness/src/cli/locked-tests.mjs`
- Modify: `codex-implement.mjs` (post-run step)
- Test: new `locked-tests.test.mjs`, `codex-implement.test.mjs`

**Interfaces:**
- `--role tests`: after the run, the runner counts new test cases (`test(`, `it(` calls added in the diff). More than `tests.maxNewCases` (default 8) → exit 4. It runs the new tests on the merge base in a temporary worktree. A test that passes there → exit 4 with its name.
- `lockTests(worktree, files) → writes <git common dir>/qc/locked-tests/<branch>.json` with `{ path: sha256 }`.
- `--role implement`: a changed, renamed, or deleted locked file → exit 4. More than `tests.maxExtraCases` (default 4) new cases → exit 4.
- After the implement run, the runner runs the locked tests and the related tests through `qc check`. Exit 0 needs both green and the marker.

**Tests:**
- `nine new cases in a tests run → exit 4 naming the cap 8`.
- `a new test that passes on the base → exit 4 naming the test`.
- `locked file edited → exit 4`; `locked file renamed → exit 4`.
- `marker written but a locked test fails → exit 3, not 0`.

**Verify:** the named test files pass.

### Task 4: the mutation check on changed lines

**Files:**
- New: `packages/qc-harness/src/cli/mutate.mjs`
- Modify: `codex-implement.mjs` (after task 3's test step)
- Test: new `mutate.test.mjs`

**Interfaces:**
- `mutants(line) → string[]`: flip `<`/`>`/`<=`/`>=`/`===`/`!==`, negate an `if` condition, swap `true`/`false`, replace `return <expr>` with `return undefined`. JS and TS only. Other languages give no mutants.
- `runMutation({ worktree, base, maxLines: 10, budgetMs: 180000 }) → { survived: [{ file, line, mutant }] }`.
- The runner writes the survivors under `## Survivors` in the report. Survivors do not fail the run. The review brief names them.

**Tests:**
- `mutants of "a < b" holds "a >= b"`.
- `a survivor appears when no test covers the line`; `no survivor when a test fails on the mutant`.
- `the run stops at budgetMs and reports how many lines it skipped`.

### Task 5: partial CI, the relaxed ready check, and the full suite on main

**Files:**
- Modify: `.github/workflows/ci.yml` and `packages/qc-harness/templates/ci.yml` (the template path from `ci-template.test.mjs`)
- Modify: `packages/qc-harness/src/cli/check.mjs` (`--affected --base <ref>`), `check-commands.mjs` (`changedFiles`)
- Modify: the `ready-check` code from PR #209
- Test: `ci-template.test.mjs`, `check-commands.test.mjs`

**Interfaces:**
- `qc check --affected --base origin/main`: runs the gates and the tests related to files changed since the base.
- CI: a pull request runs `qc check --affected`. A push to `main` and a nightly `schedule` run the full suite. A red full suite opens an issue with the labels `ci-red` and `priority`.
- `ready.platforms` legs accept the affected leg.

**Tests:**
- `the CI template runs --affected on pull_request and pnpm test on push to main and on schedule`.
- `--affected with one changed gate file runs that gate's test file and not an unrelated one`.

### Task 6: `qc milestone`

**Files:**
- New: `packages/qc-harness/src/cli/milestone.mjs`
- Modify: `qc.mjs` (command table), `integrate.mjs` (export the merge step for reuse)
- Test: new `milestone.test.mjs`

**Interfaces:**
- `milestones.times` default `["11:00", "16:00", "21:00"]`.
- A finished branch: pushed, with an APPROVED review verdict on its head in the ledger, and not in `origin/main`.
- `qc milestone [--dry-run]`: lists finished branches, merges them into `milestone/<YYYY-MM-DD>-<n>`, pushes once, and opens one ready PR whose body names each issue with `Refs #<n>`.
- A conflict: the run leaves that branch out, names it under `Left out:`, and goes on.
- `qc milestone --drop <branch>`: rebuilds the milestone without that branch and pushes again.
- Exit 0 with `nothing to merge` when no branch is finished.
- `skills/codex/SKILL.md` tells the orchestrator to schedule `qc milestone` at each of `milestones.times` with a recurring job.

**Tests:**
- `two finished branches → one milestone branch, one PR body with both Refs lines`.
- `a branch without an APPROVED verdict is not collected`.
- `one conflicting branch is left out and the other two merge`.
- `--drop rebuilds without the named branch`.

### Task 7: `qc overview` and the debt loop

**Files:**
- New: `packages/qc-harness/src/cli/overview.mjs`
- Modify: `qc.mjs`, the review checklist in `codex-implement.mjs`
- Test: new `overview.test.mjs`

**Interfaces:**
- `qc overview`: at most 60 lines. Sections: `Modules` (headings of `docs/architecture.md`), `Largest` (10 files), `Churn` (10 files, last 90 days), `CI failures` (open ledger records), `Debt` (open issues with the `debt` label, through `gh`).
- The review checklist prompt from the spec, part 4, with `## Debt` for out-of-scope items.
- `qc debt file <report>`: opens one issue with the `debt` label for each `## Debt` item. It skips a title that is already open.
- `qc debt due`: exit 0 and prints the top churn module when 10 or more milestone merges happened since the last debt review in the ledger. The orchestrator then runs a debt-only Codex review of that module.

**Tests:**
- `overview prints at most 60 lines on a repo with 200 files`.
- `debt file skips an item whose title is already an open issue`.

### Task 8: breaking-change questions, shorter skills, and cut rules

**Files:**
- Modify: `skills/codex/SKILL.md` (at most 100 lines), `plugins/architecture-extras/skills/swarm/SKILL.md`
- Modify: the CI-failure hold code (`ci-failures.mjs`), the per-scope review rule in `merge-guard.mjs`
- New: `qc ask --issue <n> "<question>"`: adds a `needs-user` label and a comment.
- Test: `ci-failures.test.mjs`, `merge-guard.test.mjs`, a docs test for the skill line count

**Interfaces:**
- The three-red-heads hold becomes a `needs-user` question. It does not block other branches.
- One review for each issue head. The scope rule goes.

**Tests:**
- `three red heads → a needs-user question, and no hold record`.
- `skills/codex/SKILL.md has at most 100 non-blank lines`.

## Order

Tasks 1 and 2 run first, one after the other. Tasks 3 to 8 then use the new flow. Tasks 5, 6, and 7 touch different files and can run at the same time.
