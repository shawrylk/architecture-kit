#!/usr/bin/env node
// The one entrypoint. A hook, a git hook and CI all call this, so they cannot drift.

import process from "node:process";
import { load } from "../config.mjs";
import { runCheck } from "./check.mjs";
import { checkFiles } from "./check-input.mjs";

const USAGE = `qc — architecture gates

  qc check [file...] [--files-from <path|->]
                           every structural gate; files given, or listed NUL-separated in a file or on stdin, take the fast path
  qc init                  scaffold the docs, config, hooks and workflow into this repository
  qc feature <name>        scaffold a feature in the configured anatomy
  qc run [name]            drive one feature command headless; no name lists them
  qc install-hooks         point git at the kit's pre-commit hook
  qc work-order-check      refuse to commit on the wrong branch, per .claude/work-order.local.json
  qc lease status [path]   who holds this worktree's lease, since when, and when it lapses
  qc lease release [path]  remove it: --session <id> for your own, --force for another's
  qc pr-check              in CI: the pull request names an issue that exists and predates it
  qc ci-wait <pr> [--max <min>] [--queued <min>]
                           wait on a PR's checks; return on a failure, a new head, a stuck queue, or the limit
  qc prose [--base <ref>] [--pr-body <file>] [--pr-body-event]
                           Vale on the lines a diff adds to the docs, and on a PR body; needs the vale binary
  qc commit-msg <file>     conventional (commitlint), English, and the trailer when attribution is on
  qc decisions [id]        where decisions are cited; --squash closes the gaps
  qc ledger [--cost] [branch]  the workflow ledger: dispatches, stops, verdicts, merges, issue updates; --cost totals tokens and tool calls
  qc codex-implement --brief <file> --worktree <path> --progress <file> [--log <file>] [--max-runs <n>]
                           run a brief through codex exec as an implementer, restarting until the progress file says ALL TASKS DONE; exit 2 on a Codex limit
  qc watch [--pr <n>]... [--codex <wrapper.log>]... [--run <workflow>@<branch>]... [--max <minutes>] [--repo <owner/name>] [--interval <seconds>]
                           block until the first event among the items, print one EVENT line; exit 0 done, 4 bound (default 55 minutes), 5 failed, 6 queued past 15 minutes
  qc plan-check <plan.md>  each task names files, a test step and a commit step, within the tool-call budget
  qc tokens [--session <id>] [--project <dir>] [--claude-dir <dir>] [--json]
                           one session's tokens and cache hit rate per agent type, from its transcripts
  qc ui <catalog|find|dupes|codemod>
                           the component catalog, a search over it, a duplicate finder and a class-token codemod
  qc worktree add <name> <branch> [--from <ref>]
                           fetch, add .worktree/<name> in the main checkout, install, print the path
  qc worktree remove <name>
                           refuse a dirty tree; delete it, then its branch once merged, pushed, or a merged PR head
  qc enforcement-map       refresh the generated rule/gate table in docs/enforcement.md
  qc doctor                the hooks and the lockfile must run the same harness
  qc config                print the resolved configuration

Every gate reads qc.config.json. A key it does not set keeps the reference default.`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  // A broken qc.config.json must not keep a lease in place, so the lease runs before the load.
  if (command === "lease") {
    const { runLease } = await import("./lease.mjs");
    process.exit(await runLease(rest));
  }
  // The runner reads no configuration, so it runs from any folder.
  if (command === "codex-implement") {
    const { runCodexImplement } = await import("./codex-implement.mjs");
    process.exit(await runCodexImplement(rest));
  }
  // The watcher reads no configuration either.
  if (command === "watch") {
    const { runWatch } = await import("./watch.mjs");
    process.exit(await runWatch(rest));
  }
  const config = load(process.cwd());

  switch (command) {
    case "check": {
      const { files, listed } = await checkFiles(rest);
      // An empty list means nothing staged to check, not the full check.
      if (listed && files.length === 0) return;
      const { problems, lines } = await runCheck(config, files);
      if (problems.length > 0) {
        for (const problem of problems) {
          console.error(`FAIL  ${problem.feature ?? problem.path}  ${problem.rule}: ${problem.detail}`);
        }
        console.error(`\n${problems.length} problem(s). ${config.docs.enforcement}`);
        process.exit(1);
      }
      for (const line of lines) console.log(line);
      return;
    }
    case "init": {
      const { runInit } = await import("./init.mjs");
      await runInit(config, rest);
      return;
    }
    case "feature": {
      const { runScaffold } = await import("./scaffold.mjs");
      await runScaffold(config, rest);
      return;
    }
    case "run": {
      const { runRun } = await import("./run.mjs");
      process.exit(await runRun(config, rest));
    }
    case "install-hooks": {
      const { installHooks } = await import("./install-hooks.mjs");
      await installHooks(config);
      return;
    }
    case "work-order-check": {
      const { runWorkOrderCheck } = await import("./work-order-guard.mjs");
      process.exit(await runWorkOrderCheck(config.root));
    }
    case "pr-check": {
      const { runPrCheck } = await import("./pr-check.mjs");
      process.exit(await runPrCheck());
    }
    case "ci-wait": {
      const { runCiWait } = await import("./ci-wait.mjs");
      process.exit(await runCiWait(rest));
    }
    case "prose": {
      const { runProse } = await import("./prose.mjs");
      process.exit(await runProse(config, rest));
    }
    case "commit-msg": {
      const { runCommitMsg } = await import("./commit-msg.mjs");
      process.exit(await runCommitMsg(config, rest[0]));
    }
    case "ledger": {
      const { runLedger } = await import("./ledger.mjs");
      process.exit(runLedger(config, rest));
    }
    case "plan-check": {
      const { runPlanCheck } = await import("./plan-check.mjs");
      process.exit(runPlanCheck(config, rest));
    }
    case "tokens": {
      const { runTokens } = await import("./tokens.mjs");
      process.exit(runTokens(config, rest));
    }
    case "decisions": {
      const { runDecisions } = await import("./decisions.mjs");
      process.exit(await runDecisions(config, rest));
      return;
    }
    case "worktree": {
      const { runWorktree } = await import("./worktree.mjs");
      process.exit(await runWorktree(config, rest));
    }
    case "ui": {
      const { runUi } = await import("./ui.mjs");
      process.exit(await runUi(config, rest));
    }
    case "enforcement-map": {
      const { runSyncEnforcementMap } = await import("./sync-enforcement-map.mjs");
      await runSyncEnforcementMap(config);
      return;
    }
    case "doctor": {
      const { runDoctor } = await import("./doctor.mjs");
      process.exit(await runDoctor(config));
    }
    case "config":
      console.log(JSON.stringify(config, null, 2));
      return;
    default:
      console.log(USAGE);
      process.exit(command === undefined || command === "help" ? 0 : 1);
  }
}

await main();
