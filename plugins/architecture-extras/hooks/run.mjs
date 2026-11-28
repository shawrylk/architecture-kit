import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Hook code comes from the harness installed in the project or with the plugin.
const name = process.argv[2];
const scripts = new Set(["pre-edit-guard.sh", "post-edit-gate.sh", "stop-gate.sh"]);
const cli = new Set([
  "checkpoint.mjs", "watch-arm.mjs", "dispatch-reminder.mjs", "dispatch-guard.mjs",
  "budget-guard.mjs", "generated-file-guard.mjs", "ui-reuse-hint.mjs", "explore-guard.mjs",
  "skill-guard.mjs", "controller-guard.mjs", "pr-guard.mjs", "report-stop.mjs",
  "plan-stop.mjs", "slot-guard.mjs", "bash-edit-guard.mjs", "explore-hint.mjs",
  "cost-stop.mjs", "issue-gate.mjs", "worktree-gate.mjs",
]);
if (!scripts.has(name) && !cli.has(name)) {
  console.error("Unknown extras hook.");
  process.exit(1);
}
let harness;
for (const base of [process.env.CLAUDE_PROJECT_DIR, process.cwd(), fileURLToPath(new URL("../", import.meta.url))].filter(Boolean)) {
  try {
    harness = path.dirname(createRequire(path.resolve(base, "package.json")).resolve("architecture-harness/package.json"));
    break;
  } catch {}
}
if (!harness) {
  console.error("Install architecture-harness in the project before you enable architecture-extras.");
  process.exit(1);
}
const shell = scripts.has(name);
const target = shell ? fileURLToPath(new URL(name, import.meta.url)) : path.join(harness, "src", "cli", name);
if (!existsSync(target)) {
  console.error(`The installed architecture-harness does not include ${name}.`);
  process.exit(1);
}
const result = spawnSync(shell ? "bash" : process.execPath, [target], {
  stdio: "inherit",
  env: { ...process.env, QC_HARNESS_ROOT: harness },
});
if (result.error) console.error(result.error.message);
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
