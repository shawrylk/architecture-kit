---
name: codex
description: How a Claude controller runs Codex implementers through `qc codex-implement` with lean context — roles, the brief, the launch, the result files, CI, the branch review, and the merge. Use when you dispatch implementer work, fix a CI failure or a review finding, or drive a pull request to a green, merged state.
---

# Codex implementers

## Roles

- Claude orchestrates: it writes briefs, dispatches, watches CI, runs reviews, merges, and closes issues.
- Codex writes each change to code. A CI fix, a review fix, and a merge with conflicts are each a Codex brief.
- The one exception is a fix inside the `swarm.direct` limits, where that lane is on. The main session makes that edit.
- The main session also edits the controller paths that the guard allows, such as `*.md` and `docs/**`. A clean `git merge` and a `git push` by hand are fine.
- Reviews stay on Claude, with `architecture:sdd-branch-reviewer` (opus). The merge guard counts only a branch review by default.
- On exit 2, a Codex limit, send the same brief to an `architecture:sdd-implementer` (sonnet).

## Write the brief

Write the brief as a markdown file in your scratchpad. It holds these parts:

| Part | Content |
|---|---|
| Header | The worktree path, the branch, the issue, and the report file |
| `## Product decisions` | The user's answers. Codex never asks the user. |
| Task | The exact change, the files, and the cause of a failure |
| Constraints | What Codex must leave alone, such as a shared database or another session's worktree. Codex never bypasses a git hook and never stops to ask: it writes a question in the report and continues. |
| Commit | The message shape and the issue reference |
| Exit criteria | Typecheck, the named test files, the push, and the done marker |

## Lean defaults

The runner adds these to the prompt of every run, so a brief carries no lean section:

- At session start, Codex rewrites the progress file to at most 40 lines: the pushed head, one line for each done item, the first unfinished item, and the open questions.
- It never re-verifies a finished item, never repeats a failed probe, and reads only the line ranges the item needs.
- It loads no skill and reads no `SKILL.md` or plugin file: the runner turns off every plugin the user's Codex config enables, and `superpowers@claude-plugins-official`, with `-c`.
- It searches with `rg -n -m 20` and a path, reads at most 150 lines per call, limits any command that can print over 4,000 characters, never runs `gh issue view`, and uses `git status --short` and `git log -n 5 --oneline`. The runner also sets `tool_output_token_limit=4000` and `model_auto_compact_token_limit` from `codex.compactTokens` (default 300000).
- It starts no helper agents, and the runner turns off the Codex `multi_agent` and `multi_agent_v2` features with `-c`. It runs no broad audit, Playwright, or full gate: the touched tests, and the local check once before the push.
- It does one item for each session, and keeps the report under 15 lines.
- A lean rule never drops a security, tenant, data, or correctness check that the brief asks for.

- End the exit criteria with: "append `ALL TASKS DONE` to the progress file". The runner looks for that exact text anywhere in the file. Any other marker, such as `DONE`, makes it repeat runs until `--max-runs`.
- Ask for a Claude co-author trailer only when `commitMessage.attribution` in `qc.config.json` is on. With it off, the brief says "no Claude co-author trailer".
- Never tell Codex to skip a hook. A brief that says "no local checks" makes Codex treat the pre-push hook as out of scope, and it loops while it asks for permission to push.
- The runner reads the brief again before each run. Edit the brief file to change the scope or record a decision. The next session holds the edit, and the runner needs no restart.

## Launch a run

Run this in the background from the main checkout. The form is for PowerShell:

```powershell
npx qc codex-implement --brief <brief.md> --worktree <absolute worktree path> --progress <progress.md> --log <codex.log> --max-runs 12 *> <wrapper.log>; "exit $LASTEXITCODE"
```

- In a POSIX shell, use this form:

  ```bash
  npx qc codex-implement --brief <brief.md> --worktree <absolute worktree path> --progress <progress.md> --log <codex.log> --max-runs 12 > <wrapper.log> 2>&1; echo "exit $?"
  ```
- Never call `codex exec` directly. Each run of the runner is a fresh `codex exec` in the worktree, with full access. Its prompt is the brief plus a note that points at the progress file.
- Start Codex only inside a worktree from `qc worktree add`. Never start it in the main checkout, the scratchpad, or the home folder. A run outside a repository can make a code indexer read the whole home folder.
- Use `--max-runs` from 10 to 20. Each run continues from the progress file.
- Codex runs count as implementers. Run one at a time, as the swarm rules say. Run more only up to `swarm.dispatch.implementerSlots`, on disjoint paths, and with more than 4 GB of free memory for each extra run.

## Read the result

| Exit | Meaning | Next step |
|---|---|---|
| 0 | The progress file holds `ALL TASKS DONE` | Read the report tail, then check the diff |
| 1 | Bad input, or no `codex` on the `PATH` | Fix the command |
| 2 | A Codex usage or spend limit | Send the same brief to `architecture:sdd-implementer` (sonnet) |
| 3 | Out of runs | Read the progress tail. The work is often complete with a wrong marker. |

- Read only the tails: `tail -c 600 <progress.md>` and the end of the report.
- Never read the Codex log or a JSONL transcript. They fill the context.
- Read the diff of each test file yourself. A removed or weakened assertion is a finding.

## Keep the context lean

- Keep a `checkpoint.md` in the scratchpad. Update it at each clean break: the head, the CI state, the open agents, and each decision.
- Cap every subagent reply: "a `VERDICT` line and at most 25 lines". The subagent writes its full output to a scratchpad file.
- Poll CI with one background command for each head, then wait for its notification:

  ```bash
  sleep 60; gh pr checks <n> --watch --interval 60 >/dev/null 2>&1; gh pr view <n> --json headRefOid,statusCheckRollup --jq '.headRefOid, (.statusCheckRollup[] | "\(.name): \(.conclusion // .status)")'
  ```

- Never poll in a loop of tool calls, and never send "are you done?" messages.
- If Claude Code stops a background command for low memory, do not start it again. Poll in the foreground with a `timeout` instead.
- After a review with findings, give the fix round to a fresh Codex run with a new brief. Fold a minor finding into the next brief.
- A Claude implementer that replaces a reviewed one gets a `NO-RESUME: <reason>` line in its `Agent` prompt. A Codex run needs no such line.

## Review

- Review a head only when CI on it is green and it contains the tip of the base branch.
- Every dispatch carries a `Brief: <path>` line, a `Worktree: <path>` line, and a named model.
- A pull request gets one branch review. Each fix round gets one `architecture:sdd-branch-reviewer` review of its increment, with a `Reviewed: <sha>` line that names the last reviewed head.

## CI failures

- Read the failed step and the assertion before you act. Fetch the log of a job with `gh api repos/<owner>/<repo>/actions/jobs/<job id>/logs`.
- Rerun a known flake once with `gh run rerun <run id> --failed`.
- A runner or Docker failure that comes back, or a runner that stays offline, needs the user. Never change the CI routing, and never skip CI.
- A real failure is a Codex brief.

## Merge

1. Grep the pull request body for "no merge is authorized". If it matches, stop.
2. Merge with `gh pr merge <n> --merge --match-head-commit <the 40-character sha>`. Where the repository turns off merge commits, use the method it allows, still with `--match-head-commit`.
3. Never use `--admin` or a force-push.
4. Confirm that the pull request shows `MERGED` and that its head is in the base. After a squash, confirm that the base holds the change.
5. Close each issue that the pull request names with `Refs`.
6. Remove the worktree with `npx qc worktree remove <name>` from the main checkout.
