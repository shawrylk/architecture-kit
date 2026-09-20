#!/usr/bin/env node
// The one entrypoint. A hook, a git hook and CI all call this, so they cannot drift.

import process from "node:process";
import { load } from "../config.mjs";
import { runCheck } from "./check.mjs";

const USAGE = `qc — architecture gates

  qc check [file]        every structural gate; one file is the fast path a hook takes
  qc init                scaffold the docs, config, hooks and workflow into this repository
  qc feature <name>      scaffold a feature in the configured anatomy
  qc install-hooks       point git at the kit's pre-commit hook
  qc work-order-check    refuse to commit on the wrong branch, per .claude/work-order.local.json
  qc commit-msg <file>   refuse a commit message that credits a tool as an author
  qc decisions [id]      where decisions are cited; --squash closes the gaps
  qc enforcement-map     refresh the generated rule/gate table in docs/enforcement.md
  qc doctor              the hooks and the lockfile must run the same harness
  qc config              print the resolved configuration

Every gate reads qc.config.json. A key it does not set keeps the reference default.`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const config = load(process.cwd());

  switch (command) {
    case "check": {
      const { problems, lines } = await runCheck(config, rest[0]);
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
    case "install-hooks": {
      const { installHooks } = await import("./install-hooks.mjs");
      await installHooks(config);
      return;
    }
    case "work-order-check": {
      const { runWorkOrderCheck } = await import("./work-order-guard.mjs");
      process.exit(await runWorkOrderCheck(config.root));
    }
    case "commit-msg": {
      const { readFileSync } = await import("node:fs");
      const { checkCommitAttribution } = await import("./commit-attribution.mjs");
      const problems = checkCommitAttribution(readFileSync(rest[0], "utf8"), config.commitMessage);
      for (const problem of problems) console.error(`FAIL  commit-msg  ${problem.rule}: ${problem.detail}`);
      process.exit(problems.length > 0 ? 1 : 0);
    }
    case "decisions": {
      const { runDecisions } = await import("./decisions.mjs");
      process.exit(await runDecisions(config, rest));
      return;
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
