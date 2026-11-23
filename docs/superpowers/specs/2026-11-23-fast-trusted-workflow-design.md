# Fast and trusted agent workflow

Date: 2026-11-23. Status: approved by the user, with the no-human-step and milestone changes.

## Intent

The kit is too slow, and agents no longer follow it. The models also make worse code than before.
You see four failures:

- The model claims success that is not true.
- The model writes wrong code.
- The model skips tests.
- The model writes too many tests.

All four have one cause: the kit trusts what the model says about its own work.
This design moves trust from the model's words to checks that the runner does itself.
It also cuts rules that no code enforces, and it runs CI once per batch, not once per issue.

You want three more things:

- The orchestrator keeps the best design. A subagent must not take a wrong direction or a wrong architecture.
- The orchestrator sees the whole project: the module map, bad code, and tech debt.
- The orchestrator opens new issues for debt, and they go through the same workflow.
- Each subagent first scouts and reports the plan, the root cause, and the related things to check. The orchestrator approves, then gives the fix to the same subagent or a different one.
- The whole workflow runs with no human step. The orchestrator asks the user only when it is not sure, or before a breaking change.
- Merges happen at milestones, two or three times each day. All fixes that are ready by a milestone go to `main` in one PR and one CI run.

## Goals

1. One issue goes from brief to pushed branch on the local machine, with no PR and no GitHub CI.
2. A batch of issues gets one integration branch, one draft PR, and one CI run of the affected tests.
3. A code run cannot pass by its own claim. The runner runs the tests and reads the result.
4. A code run cannot change the acceptance tests that a separate run wrote.
5. The orchestrator fixes the design before code starts, and the runner refuses a diff outside it.
6. Codex `gpt-6.1-sol` writes and reviews code. The model name is a setting, not a global edit.
7. Debt that a review or a scan finds becomes a GitHub issue with the `debt` label.

## Non-goals

- A weekly benchmark of model quality. This can come later.
- Changes to the checks that the kit gives to adopting repositories, other than the CI template.

## Anti-goals

- A security, tenant, data, or correctness check that disappears to save time.
- A red `main` that nobody fixes. A red full suite on `main` opens a top-priority issue.

## Approaches

| Approach | What it does | Cost | Result |
|---|---|---|---|
| 1. Checks the model cannot talk past | Locked tests, tests that the runner runs, a test cap, a mutation check, a review checklist | One more Codex run per issue | Picked |
| 2. Measure, then switch models | A fixed task set with known answers, and a model pin | Finds a bad model, but does not stop a bad change | Only the model pin is taken |
| 3. Two models check each other | Codex writes, Claude reviews | Goes against the Codex-review choice, uses Claude tokens | Not taken |

The user asked me to choose. I picked Approach 1 with the model pin.

## Design

### 1. The model pin

- New settings: `codex.model`, `codex.reviewModel` (default `gpt-6.1-sol`), and `codex.reviewEffort` (default `high`).
- The runner passes `-c model=<value>` on each run. The user's `~/.codex/config.toml` goes back to its own value.

### 2. The orchestrator owns the design

- `docs/architecture.md` holds the module map: each module, what it owns, the allowed import directions, and the pattern to copy. At most 150 lines. Only the orchestrator edits it.
- Each brief gets a `## Design` part: the files to change, the new files allowed, the function signatures, and a `file:line` of code to copy. The brief check refuses a brief without it.
- Every issue starts with a scout run (`Role: scout`). The scout reads code, edits nothing, and writes a scout report of at most 40 lines:
  - `Root cause:` for a bug, or `Gap:` for a feature, with `file:line` evidence,
  - `Plan:` at most six steps, with the files to change,
  - `Check:` the related things the orchestrator must look at: callers, other users of the same code, tests, settings, and docs,
  - `Risks:` and `Questions:`.
- The orchestrator reviews the scout report against `docs/architecture.md`. It can approve the report, rewrite the `## Design` part, or send a new scout run.
- The runner refuses a code run until the brief holds `Approved: <scout report path>`.
- The orchestrator then picks who does the fix:
  - the same Codex session, resumed, when the scout went the right way and its context helps,
  - a fresh run, when the scout went the wrong way or the fix needs a different focus.
- The scout run counts toward the read budget. The code run gets a new read budget of 15 files.
- After each code run, the runner checks the shape of the diff. It refuses (exit 4) when:
  - a changed file is outside `Paths:`,
  - a new package dependency is not named in `## Design`,
  - the diff has more than `codex.maxDiffLines` lines (default 400). The message says "split the issue".

### 3. Tests the model cannot talk past

- A test run (`Role: tests`) comes first. It reads the issue and the `## Design` part, and writes the acceptance tests.
- The cap is `tests.maxNewCases` (default 8) new cases for each issue.
- The runner runs these tests on the base. They must fail there. A test that passes on the base proves nothing, so the runner refuses it.
- The runner stores a hash of each acceptance test file in `.git/qc/locked-tests/<branch>.json`.
- The code run cannot change a locked file. The runner compares the hashes and refuses a change (exit 4).
- The code run can add at most `tests.maxExtraCases` (default 4) more cases.
- After the code run, the runner runs the locked tests and the affected tests itself. Exit 0 needs both green. The `ALL TASKS DONE` marker alone is not enough.
- A mutation check runs on up to 10 changed lines. It flips a comparison, negates a condition, or swaps a return value. Then it runs the affected tests. A mutant that survives goes to the review as a finding. The check stops after 3 minutes.

### 4. The review

- One Codex review run for each issue, on the pushed head, at `high` effort.
- The runner adds a fixed checklist to the review prompt:
  1. Does the diff fit `docs/architecture.md` and the `## Design` part?
  2. Which input gives a wrong result? Give `file:line` and the input.
  3. Do the tests prove the issue? Name any test that adds nothing.
  4. Is there a simpler way with less code?
  5. Put debt outside the scope under `## Debt`, not under findings.
- The merge guard accepts a Codex review verdict when `review.runtime` is `"codex"`. Today it counts only a Claude branch review.
- The runner reads the `VERDICT:` line of the review report and writes it to the review ledger with the head SHA. The merge guard reads that entry. (My call.)
- The orchestrator writes the first `docs/architecture.md` for this kit in issue 2, from the current `src` folders. Issue 6 adds `qc overview` later. (My call.)

### 5. The debt loop

- `qc overview` prints at most 60 lines:
  - the module map from `docs/architecture.md`,
  - the 10 largest source files,
  - the 10 files with the most changes in the last 90 days,
  - the files with open CI failure records,
  - the open issues with the `debt` label.
- The orchestrator runs it at session start and after each merge.
- For each `## Debt` item in a review, and each new hot spot, the orchestrator opens an issue with the `debt` label. It skips an issue whose title is already open.
- After every 10 merges, the orchestrator runs one Codex review of the top hot-spot module, for debt only.
- Debt issues go through the same workflow as other issues.

### 6. No human step

- The orchestrator is the Claude main session. It approves scout reports, merges, and opens debt issues on its own.
- It asks the user only in these cases:
  - it is not sure which way is right, after the scout report and `docs/architecture.md`,
  - the change breaks a public interface: a CLI flag, a config key, a hook, an exit code, or a file format that an adopting repository uses,
  - the same branch has failed CI three times,
  - a product decision is missing.
- The scout report has a `Breaking:` line, `yes` or `no`, with the reason. `yes` stops the issue until the user answers. Other issues go on.
- A question to the user goes into one GitHub issue comment with the `needs-user` label, and the session notifies the user. The orchestrator works on other issues while it waits.

### 7. Merge milestones

- `milestones.times` in `qc.config.json` sets the merge times, for example `["11:00", "16:00", "21:00"]` in local time.
- Between milestones, each finished issue branch waits. It has its review approval and its local test results, and it has no PR.
- At each milestone, `qc milestone` runs:
  1. it collects every finished issue branch that `main` does not hold,
  2. it merges them with `qc integrate` into `milestone/<date>-<n>`, and pushes once,
  3. it opens one PR, ready for review, with every issue in the body,
  4. CI runs once on the affected tests,
  5. on green CI, the orchestrator merges with `--match-head-commit` and closes the issues.
- A conflict in a milestone goes to a Codex fix run with one review. The other branches wait in the same milestone.
- A red milestone CI: the orchestrator finds the branch that caused it. It drops that branch from the milestone and merges the rest. The dropped branch goes back to its issue for a fix.
- A milestone with no finished branch does nothing.
- The orchestrator schedules `qc milestone` with a recurring job at the set times.

### 8. Speed

- The path of one issue, all on the local machine:
  1. scout run, then the orchestrator approves the plan,
  2. test run,
  3. code run, by the same session or a fresh one,
  4. runner tests (locked and affected unit tests),
  5. affected end-to-end tests (`qc e2e-affected` exists),
  6. mutation check,
  7. Codex review,
  8. push the branch.
- `qc milestone` merges finished issues into one branch with one PR (part 7).
- CI on the milestone PR runs `qc check --affected --base origin/main`: the affected tests on Linux and Windows.
- The full suite runs on each push to `main` and once each night.
- `qc ready-check` asks for the affected leg, not a full local Docker leg.
- Cut these rules:
  - the hold after three red heads,
  - one review for each scope,
  - the heartbeat,
  - every rule in a skill that no code enforces and that this design does not need.
- `skills/codex/SKILL.md` goes from 203 lines to at most 100.

## Issues, in order

1. The model pin, and the merge guard accepts a Codex review.
2. The scout run, the approval line, the session resume, the `## Design` part, and the diff shape check.
3. The test run, the locked tests, the runner-run tests, and the test caps.
4. The mutation check on changed lines.
5. Partial CI, the relaxed ready check, and the full suite on `main` and each night.
6. `qc milestone`, the milestone schedule, and dropping a red branch from a milestone.
7. `qc overview` and the debt loop.
8. The `Breaking:` line, the `needs-user` questions, shorter skills, and the cut rules.

Issues 1 and 2 come first because the others build on them. This work runs on itself: from issue 3 onward, each issue uses the new workflow.

## Left to the builder

- The exact mutation operators for each language, inside the 3-minute limit.
- How `--affected` maps a changed file to its tests. Build on the related-test logic in `check-commands.mjs`.
- The names of the new exit messages.
- How the runner resumes a Codex session. `codex exec resume` is the likely path. Check the Codex CLI version first.
