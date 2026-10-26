#!/usr/bin/env node
// The one entrypoint. A hook, a git hook and CI all call this, so they cannot drift.

import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { load } from "../config.mjs";
import { runCheck } from "./check.mjs";
import { checkFiles } from "./check-input.mjs";

const USAGE = `qc — architecture gates

  qc check [file...] [--files-from <path|->] [--since-push]
                           every structural gate; files given, or listed NUL-separated in a file or on stdin, take the fast path
  qc e2e                   the repository's e2e command with the changed files
  qc lint [--staged] [--base <ref>] [file...]
                           ESLint on the changed lines only: a problem on an untouched line never fails
  qc typecheck             the typecheck script, else tsc; writes no build output
  qc init [--full]         scaffold the config, hooks and workflow; --full adds the reference architecture
  qc user-config apply|check|capture [--dry-run]
                           synchronize the shared Claude and Codex user settings
  qc setup [--dry-run] [--config <file>] [--model <id>]...
                           set up user compaction, the Claude core rules, and personal skills
  qc feature <name>        scaffold a feature of the reference architecture; needs qc init --full
  qc run [name]            drive one feature command headless; no name lists them
  qc install-hooks         point git at the kit's pre-commit hook
  qc work-order-check      refuse to commit on the wrong branch, per .claude/work-order.local.json
  qc commit-guard          refuse staged protected paths, secrets, and conflict markers
  qc lease status [path]   who holds this worktree's lease, since when, and when it lapses
  qc lease release [path]  remove it: --session <id> for your own, --force for another's
  qc pr-check              in CI: the pull request names an issue that exists and predates it
  qc prose [--base <ref>] [--pr-body <file>] [--pr-body-event]
                           Vale on the lines a diff adds to the docs, and on a PR body; needs the vale binary
  qc commit-msg <file>     conventional (commitlint), English, and the trailer when attribution is on
  qc decisions [id]        where decisions are cited; --squash closes the gaps
  qc ledger [--cost] [branch]  the workflow ledger: dispatches, stops, verdicts, merges, issue updates; --cost totals tokens and tool calls
  qc budget report        each role's end context, peaks at handoffAt, and advice on its limit
  qc codex-implement --brief <file> --worktree <path> --progress <file> [--log <file>] [--max-runs <n>] [--effort <low|medium|high>] [--wait-reset] [--max-hours <n>] [--poll-minutes <n>]
                           run a brief through codex exec as an implementer; done means the last non-empty progress line equals ALL TASKS DONE after trimming whitespace
                           the runner supplies the marker; write it as the last line, alone, only when the exit criteria hold; never quote it elsewhere or wait for it; exit 2 on a Codex limit
                           --effort overrides the Codex config for every run; omitting it keeps the config value
                           --wait-reset polls every 30 minutes without a model, then resumes the same brief; --poll-minutes sets the interval; --max-hours defaults to 6
  qc codex-wait-reset --since <iso> [--max-hours <n>] [--poll-minutes <n>]
                           wait for a later Codex reset without a model; exit 0 on a reset, 1 at the bound; default 6 hours and 30 minutes between polls
  qc codex status         print whether Codex is free or limited, with the expiry time and its source
  qc gate-slot [--slots <n>] -- <command...>
                           run a heavy local command in one of the machine's gate slots; --status lists them
  qc watch [--pr <n>]... [--codex <wrapper.log>]... [--run <workflow>@<branch>[@<sha>]]... [--max <minutes>] [--repo <owner/name>] [--interval <seconds>]
                           block until the first event among the items, print one EVENT line; exit 0 done, 1 bad input, 4 bound (default 55 minutes), 5 failed, 6 queued past 15 minutes
  qc screens --map <json> --targets <left,right> --out <dir> [--only <names>] [--changed <target>]
                           capture authenticated screen pairs, compare pixels, and write a static gallery
  qc stack up|down|status [names...] [--timeout <milliseconds>]
                           run repository plugins from ~/.qc/stacks.json
  qc plan-check <plan.md>  each task names files, a test step and a commit step, within the tool-call budget
  qc review promotion <pr>  write the scoped promotion brief for the configured integration and release branches
  qc tokens [--session <id>] [--project <dir>] [--claude-dir <dir>] [--json]
                           one session's tokens and cache hit rate per agent type, from its transcripts
  qc throwaway-db [--port <n>|auto] -- <command...>
                           run a command on a database of its own, in a container on a free port
  qc retry-failed --report <json> --rerun "<command>" -- <command...>
                           rerun only the failed test files once before the run fails
  qc ui <catalog|find|dupes|codemod>
                           the component catalog, a search over it, a duplicate finder and a class-token codemod
  qc worktree add <name> <branch> [--from <ref>]
                           fetch, add .worktree/<name> in the main checkout, install, print the path
  qc worktree remove <name>
                           refuse a dirty tree; delete it, then its branch once merged, pushed, or a merged PR head
  qc migrations renumber --onto <ref> [--branch <ref>]
                           move this branch's migrations after the last one of <ref>, and rewrite references
  qc branch sync <worktree> [--base <ref>] [--no-push]
                           merge the base, renumber migrations, regenerate, and push through a machine gate slot
  qc integrate --issue <n> [--type <t>] [--slug <s>] [--from <ref>] <branch>...
                           one <t>/<n>-<s> branch for a batch: merge, renumber, regenerate; stop on a conflict
  qc enforcement-map       refresh the generated rule/gate table in docs/enforcement.md
  qc doctor                the hooks and the lockfile must run the same harness
  qc config                print the resolved configuration

Every gate reads qc.config.json. A key it does not set keeps the reference default.`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "user-config") {
    const { runUserConfig } = await import("./user-config.mjs");
    process.exit(await runUserConfig(rest));
  }
  if (command === "setup") {
    const { runSetup } = await import("./setup.mjs");
    process.exit(await runSetup(rest));
  }
  if (command === "stack") {
    const { runStack } = await import("./stack.mjs");
    process.exit(await runStack(rest));
  }
  if (command === "screens") {
    // The screen packages are optional peers: only this command needs them, so a repository installs them for it.
    try {
      const { runScreens } = await import("./screens.mjs");
      process.exit(await runScreens(rest));
    } catch (error) {
      const missing = /Cannot find package '(playwright|pixelmatch|pngjs)'/.exec(error?.message ?? "");
      if (error?.code !== "ERR_MODULE_NOT_FOUND" || !missing) throw error;
      console.error(`qc screens needs the ${missing[1]} package. Install the screen packages: pnpm add -D playwright pixelmatch pngjs`);
      process.exit(2);
    }
  }
  // A broken qc.config.json must not keep a lease in place, so the lease runs before the load.
  if (command === "lease") {
    const { runLease } = await import("./lease.mjs");
    process.exit(await runLease(rest));
  }
  // The runner reads no configuration, so it runs from any folder.
  if (command === "codex-implement") {
    const { runCodexImplement } = await import("./codex-implement.mjs");
    process.exitCode = await runCodexImplement(rest);
    return;
  }
  if (command === "codex-wait-reset") {
    const { runCodexWaitReset } = await import("./codex-reset.mjs");
    process.exitCode = await runCodexWaitReset(rest);
    return;
  }
  if (command === "codex") {
    if (rest[0] === "status") {
      const { runCodexStatus } = await import("./codex-limit.mjs");
      process.exitCode = runCodexStatus(rest.slice(1));
      return;
    }
    console.log(USAGE);
    process.exit(1);
  }
  // The slots are machine-wide, so the runner reads no configuration.
  if (command === "gate-slot") {
    const { runGateSlot } = await import("./gate-slot.mjs");
    process.exit(await runGateSlot(rest));
  }
  // The watcher reads no configuration either.
  if (command === "watch") {
    const { runWatch } = await import("./watch.mjs");
    process.exit(await runWatch(rest));
  }
  let config;
  try {
    config = load(process.cwd());
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    console.error(`qc: invalid qc.config.json: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  switch (command) {
    case "e2e": {
      const { runE2e } = await import("./e2e-affected.mjs");
      process.exitCode = await runE2e(config);
      return;
    }
    case "check": {
      const sincePush = rest.includes("--since-push");
      const { files, listed } = await checkFiles(rest.filter((arg) => arg !== "--since-push"));
      // An empty list means nothing staged to check, not the full check.
      const { problems, lines } = listed && files.length === 0
        ? { problems: [], lines: [] }
        : await runCheck(config, files);
      if (problems.length > 0) {
        for (const problem of problems) {
          console.error(`FAIL  ${problem.feature ?? problem.path}  ${problem.rule}: ${problem.detail}`);
        }
        const guide = existsSync(path.join(config.root, config.docs.enforcement)) ? ` ${config.docs.enforcement}` : "";
        console.error(`\n${problems.length} problem(s).${guide}`);
        process.exit(1);
      }
      for (const line of lines) console.log(line);
      const { runCheckCommands } = await import("./check-commands.mjs");
      process.exitCode = await runCheckCommands(config, { sincePush });
      return;
    }
    case "lint": {
      const { runLintChanged } = await import("./lint-changed.mjs");
      process.exit(await runLintChanged(config, rest));
    }
    case "typecheck": {
      const { runTypecheck } = await import("./typecheck.mjs");
      process.exit(runTypecheck(config));
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
    case "commit-guard": {
      const { runCommitGuard } = await import("./commit-guard.mjs");
      process.exit(runCommitGuard(config));
    }
    case "pr-check": {
      const { runPrCheck } = await import("./pr-check.mjs");
      process.exit(await runPrCheck());
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
    case "budget": {
      const { runBudget } = await import("./budget-report.mjs");
      process.exit(runBudget(config, rest));
    }
    case "plan-check": {
      const { runPlanCheck } = await import("./plan-check.mjs");
      process.exit(runPlanCheck(config, rest));
    }
    case "review": {
      const { runReview } = await import("./review-promotion.mjs");
      process.exit(runReview(config, rest));
    }
    case "tokens": {
      const { runTokens } = await import("./tokens.mjs");
      process.exit(runTokens(config, rest));
    }
    case "throwaway-db": {
      const { runThrowawayDb } = await import("./throwaway-db.mjs");
      process.exit(await runThrowawayDb(config, rest));
    }
    case "retry-failed": {
      const { runRetryFailed } = await import("./retry-failed.mjs");
      process.exit(await runRetryFailed(rest));
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
    case "migrations": {
      const { runMigrations } = await import("./migrations.mjs");
      process.exit(runMigrations(config, rest));
    }
    case "branch": {
      const { runBranch } = await import("./branch-sync.mjs");
      process.exit(await runBranch(config, rest));
    }
    case "integrate": {
      const { runIntegrate } = await import("./integrate.mjs");
      process.exit(await runIntegrate(config, rest));
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
