// A human is bound by exactly what binds an agent, so the hook is installed rather
// than documented. core.hooksPath is repository-local and survives a clone only if
// somebody runs this, which is why it also belongs in a `prepare` script.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const run = promisify(execFile);

export async function installHooks(config, dir = ".githooks") {
  const hooks = path.join(config.root, dir);
  if (!existsSync(hooks)) {
    console.error(`No ${dir}/ here. Run \`qc init\` first.`);
    process.exitCode = 1;
    return;
  }
  for (const name of ["pre-commit", "commit-msg", "pre-push"]) {
    const hook = path.join(hooks, name);
    if (existsSync(hook)) await chmod(hook, 0o755);
  }
  await run("git", ["config", "core.hooksPath", dir], { cwd: config.root });
  console.log(`git core.hooksPath -> ${dir}`);
}
