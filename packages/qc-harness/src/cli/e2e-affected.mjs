// A branch that selects the configured e2e command for the changed files.
import { changedFiles, runCommand } from "./check-commands.mjs";

export async function runE2e(config) {
  if (config.check.e2e === null) {
    console.log("SKIP  check.e2e is null; no e2e command to run");
    return 0;
  }
  const files = changedFiles(config.root, config.check.base);
  if (files?.length === 0) {
    console.log("SKIP  no changed file; no e2e spec to pick");
    return 0;
  }
  return runCommand(config.root, config.check.e2e, files ?? []);
}
