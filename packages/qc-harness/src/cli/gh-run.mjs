// A fragment that runs one gh call for a workflow hook. The caller passes the GH_* settings the user's
// own command made, so the hook reads with the account that command used.

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const GH_TIMEOUT_MS = 20_000;

/** Expands a leading `~`, `~/`, or `~\` in each value, as a shell does for an assignment. */
export function expandHome(env) {
  return Object.fromEntries(
    Object.entries(env ?? {}).map(([name, value]) => [
      name,
      typeof value === "string" && (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) ? path.join(os.homedir(), value.slice(1)) : value,
    ]),
  );
}

/** @returns gh's stdout on exit 0, or null when gh fails, times out, or is not installed. */
export function runGh(args, { cwd = process.cwd(), env = {}, timeoutMs = GH_TIMEOUT_MS } = {}) {
  const result = spawnSync("gh", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    env: { ...process.env, ...expandHome(env) },
  });
  return result.status === 0 ? (result.stdout ?? "") : null;
}
